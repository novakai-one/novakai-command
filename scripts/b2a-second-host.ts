#!/usr/bin/env -S npx tsx
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';

interface ParsedArgs {
  root?: string;
}

interface SpineWorkflow {
  workflowId: string;
  originalClientOpId: string;
  state: string;
}

type Frame = Record<string, unknown>;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      parsed.root = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const umbrellaCli = path.join(repoRoot, 'scripts', 'nvk.mjs');
const tokenCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-token.ts');
const messagingServerCli = path.join(
  repoRoot,
  'packages',
  'messaging',
  'protocol',
  'standalone-server.ts',
);
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const surfaceCoverage: string[] = [];
const startedProcesses: string[] = [];

function recordSurface(operation: string): void {
  if (!surfaceCoverage.includes(operation)) surfaceCoverage.push(operation);
}

function invoke(
  root: string,
  bearer: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  recordSurface(args.slice(0, 2).join(' '));
  return spawnSync(process.execPath, [umbrellaCli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_ROOT: root,
      NOVAKAI_TOKEN: bearer,
      ...extraEnv,
    },
  });
}

function invokeJson<T>(
  root: string,
  bearer: string,
  args: string[],
): T {
  const result = invoke(root, bearer, args);
  if (result.status !== 0) {
    throw new Error(
      `nvk ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

function invokeBytes(
  root: string,
  bearer: string,
  args: string[],
): Buffer {
  recordSurface(args.slice(0, 2).join(' '));
  const result = spawnSync(
    process.execPath,
    [umbrellaCli, ...args],
    {
      env: {
        ...process.env,
        NOVAKAI_ROOT: root,
        NOVAKAI_TOKEN: bearer,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `nvk ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`,
    );
  }
  return result.stdout;
}

function provisionToken(root: string): string {
  recordSurface('token mint');
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      tokenCli,
      'mint',
      'person_secondhost',
      '--grants',
      'project,projectItem,artifact,spine,spineStep',
      '--roles',
      'Human',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NOVAKAI_ROOT: root,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `nvk-token mint failed: ${result.stderr || result.stdout}`,
    );
  }
  const bearer = /^bearer:\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
  if (!bearer) throw new Error('nvk-token mint did not print a bearer');
  return bearer;
}

async function startMessagingServer(
  configPath: string,
): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  startedProcesses.push('messaging-standalone');
  const child = spawn(
    process.execPath,
    [tsxCli, messagingServerCli, '--config', configPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Messaging WS startup timed out: ${errors || output}`));
    }, 10_000);
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      for (const line of output.split('\n')) {
        const match = /^READY\s+(\d+)$/.exec(line.trim());
        if (match) {
          finish(() => resolve(Number(match[1])));
          return;
        }
      }
    });
    child.once('exit', (code) => {
      finish(() => reject(
        new Error(`Messaging WS exited ${String(code)}: ${errors || output}`),
      ));
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
  });
  return { child, port };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);
  if (child.exitCode === null) {
    const killed = once(child, 'exit');
    child.kill('SIGKILL');
    await killed;
  }
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function request(socket: WebSocket, frame: Frame): Promise<Frame> {
  const requestId = frame.requestId;
  const response = new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Messaging WS request ${String(requestId)} timed out`));
    }, 10_000);
    const onMessage = (data: RawData): void => {
      const candidate = JSON.parse(data.toString()) as Frame;
      if (candidate.requestId !== requestId) return;
      cleanup();
      resolve(candidate);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
  socket.send(JSON.stringify(frame));
  return response;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

async function authenticateSocket(
  socket: WebSocket,
  token: string,
  requestId: string,
): Promise<void> {
  const result = await request(socket, {
    kind: 'authenticate',
    requestId,
    credential: { token },
    protocolVersion: '1.0.0',
  });
  if (result.kind !== 'authenticated') {
    throw new Error(`Messaging authentication failed: ${JSON.stringify(result)}`);
  }
}

async function seedMessage(
  workspace: string,
  root: string,
  bearer: string,
): Promise<string> {
  const recipientToken = 'b2a-second-host-recipient';
  const configPath = path.join(workspace, 'messaging-standalone.json');
  writeFileSync(configPath, `${JSON.stringify({
    dataPath: path.join(root, 'messaging.jsonl'),
    port: 0,
    authority: {
      principals: [
        {
          token: bearer,
          personId: 'person_secondhost',
          roles: ['Human'],
        },
        {
          token: recipientToken,
          personId: 'person_secondrecipient',
          roles: ['Worker'],
        },
      ],
      roleGrants: {
        Human: ['priority.override'],
        Worker: [],
      },
    },
  })}\n`);

  // Named exception: Messaging has no message-seeding CLI. Use its published
  // standalone WS executable and wire protocol; no capability code is imported.
  const { child, port } = await startMessagingServer(configPath);
  let recipient: WebSocket | undefined;
  let sender: WebSocket | undefined;
  try {
    recipient = await connect(`ws://127.0.0.1:${port}`);
    await authenticateSocket(
      recipient,
      recipientToken,
      'auth-second-recipient',
    );
    const policy = await request(recipient, {
      kind: 'command',
      requestId: 'policy-second-recipient',
      name: 'SetContactPolicy',
      input: {
        allowlist: ['person_secondhost'],
        defaultRule: 'deny',
      },
    });
    if (policy.kind !== 'command-result') {
      throw new Error(`Messaging policy failed: ${JSON.stringify(policy)}`);
    }

    sender = await connect(`ws://127.0.0.1:${port}`);
    await authenticateSocket(sender, bearer, 'auth-second-host');
    const sent = await request(sender, {
      kind: 'command',
      requestId: 'send-second-host',
      name: 'SendMessage',
      input: {
        address: 'person:person_secondrecipient',
        body: { text: 'B2a second-host source message' },
        priority: 'normal',
        clientMessageId: 'b2a-second-host-message',
      },
    });
    if (sent.kind !== 'command-result') {
      throw new Error(`Messaging send failed: ${JSON.stringify(sent)}`);
    }
    const messageId = (sent.result as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string') {
      throw new Error('Messaging send result omitted messageId');
    }
    return messageId;
  } finally {
    if (sender) await closeSocket(sender);
    if (recipient) await closeSocket(recipient);
    await stopProcess(child);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.root
    ? path.dirname(path.resolve(args.root))
    : mkdtempSync(path.join(tmpdir(), 'nvk-b2a-second-host-'));
  const root = args.root
    ? path.resolve(args.root)
    : path.join(workspace, '.novakai');
  const source = path.join(workspace, 'b2a-second-host.bin');
  const sourceBytes = Buffer.from([0, 255, 128, 64, 32, 13, 10, 1]);
  writeFileSync(source, sourceBytes);

  const bearer = provisionToken(root);
  const messageId = await seedMessage(workspace, root, bearer);
  const project = invokeJson<{ id: string }>(root, bearer, [
    'project',
    'create',
    '--title', 'B2a second host',
    '--client-op-id', 'op_second_host_project',
  ]);
  const projectList = invokeJson<{ items: Array<{ id: string }> }>(
    root,
    bearer,
    ['project', 'list', '--status', 'active'],
  );
  const artifact = invokeJson<{ id: string; byteSize: number }>(
    root,
    bearer,
    [
      'artifact',
      'put',
      source,
      '--mime-type', 'application/octet-stream',
      '--client-op-id', 'op_second_host_artifact',
    ],
  );
  const artifactMeta = invokeJson<{ id: string; byteSize: number }>(
    root,
    bearer,
    ['artifact', 'get-meta', artifact.id],
  );
  const artifactList = invokeJson<{ items: Array<{ id: string }> }>(
    root,
    bearer,
    ['artifact', 'list'],
  );
  const artifactBytes = invokeBytes(root, bearer, [
    'artifact',
    'get-bytes',
    artifact.id,
  ]);

  const messageWorkflow = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'add-message',
      '--message', messageId,
      '--project', project.id,
      '--client-op-id', 'op_second_host_message',
    ],
  );
  const artifactWorkflow = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'attach-artifact',
      '--artifact', artifact.id,
      '--project', project.id,
      '--client-op-id', 'op_second_host_attach',
    ],
  );
  const messageStatus = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'status',
      '--workflow', messageWorkflow.workflowId,
    ],
  );
  const artifactStatus = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'status',
      '--workflow', artifactWorkflow.workflowId,
    ],
  );

  const continueSourceOp = 'op_second_host_continue_source';
  const interruptedContinue = invoke(
    root,
    bearer,
    [
      'spine',
      'add-message',
      '--message', messageId,
      '--project', project.id,
      '--client-op-id', continueSourceOp,
    ],
    { NVK_FAILPOINT: 'spine.journal.accepted.after' },
  );
  if (interruptedContinue.status === 0) {
    throw new Error('continue source failpoint did not interrupt');
  }
  const beforeContinue = invokeJson<{ items: SpineWorkflow[] }>(
    root,
    bearer,
    ['spine', 'workflows'],
  );
  const toContinue = beforeContinue.items.find(
    ({ originalClientOpId }) => originalClientOpId === continueSourceOp,
  );
  if (!toContinue) throw new Error('accepted continue source was not discovered');
  const continued = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'continue',
      '--workflow', toContinue.workflowId,
      '--client-op-id', 'op_second_host_continue',
    ],
  );

  const abandonSourceOp = 'op_second_host_abandon_source';
  const interruptedAbandon = invoke(
    root,
    bearer,
    [
      'spine',
      'attach-artifact',
      '--artifact', artifact.id,
      '--project', project.id,
      '--client-op-id', abandonSourceOp,
    ],
    { NVK_FAILPOINT: 'spine.journal.accepted.after' },
  );
  if (interruptedAbandon.status === 0) {
    throw new Error('abandon source failpoint did not interrupt');
  }
  const beforeAbandon = invokeJson<{ items: SpineWorkflow[] }>(
    root,
    bearer,
    ['spine', 'workflows'],
  );
  const toAbandon = beforeAbandon.items.find(
    ({ originalClientOpId }) => originalClientOpId === abandonSourceOp,
  );
  if (!toAbandon) throw new Error('accepted abandon source was not discovered');
  const abandoned = invokeJson<SpineWorkflow>(
    root,
    bearer,
    [
      'spine',
      'abandon',
      '--workflow', toAbandon.workflowId,
      '--client-op-id', 'op_second_host_abandon',
    ],
  );
  const items = invokeJson<{
    items: Array<{ itemRef: { kind: string; id: string } }>;
  }>(
    root,
    bearer,
    ['project', 'items', '--project', project.id],
  );
  const archived = invokeJson<{ id: string; status: string }>(
    root,
    bearer,
    [
      'project',
      'archive',
      '--project', project.id,
      '--client-op-id', 'op_second_host_archive',
    ],
  );

  process.stdout.write(`${JSON.stringify({
    root,
    projectId: project.id,
    projectListVerified: projectList.items.some(({ id }) => id === project.id),
    projectArchived:
      archived.id === project.id && archived.status === 'archived',
    artifactId: artifact.id,
    artifactBytesVerified: artifactBytes.equals(sourceBytes),
    artifactMetaVerified:
      artifactMeta.id === artifact.id
      && artifactMeta.byteSize === sourceBytes.byteLength,
    artifactListVerified: artifactList.items.some(({ id }) =>
      id === artifact.id),
    workflowStates: [messageStatus.state, artifactStatus.state],
    continuedState: continued.state,
    abandonedState: abandoned.state,
    projectRefs: items.items.map(({ itemRef }) => itemRef),
    messageSeedTransport: 'messaging-ws-exception',
    serverStarted:
      startedProcesses.includes('nvk-server')
      || surfaceCoverage.some((operation) => operation.startsWith('server ')),
    uiUsed:
      startedProcesses.some((processName) => processName.includes('ui'))
      || surfaceCoverage.some((operation) => operation.startsWith('ui ')),
    surfaceCoverage,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    code: 'SecondHostProofFailed',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
