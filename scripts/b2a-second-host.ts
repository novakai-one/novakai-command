#!/usr/bin/env -S npx tsx
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mintToken,
} from '../packages/foundation/contract/index.js';
import {
  createEmbeddedMessaging,
  createSystemClock,
  DEFAULT_ROLE_GRANTS,
  openJsonlStore,
  type MessagingSession,
  type PersonId,
} from '../packages/messaging/public/index.js';

interface ParsedArgs {
  root?: string;
}

interface SpineWorkflow {
  workflowId: string;
  originalClientOpId: string;
  state: string;
}

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

function invoke(
  root: string,
  bearer: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
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

async function seedMessage(root: string, bearer: string): Promise<string> {
  const clock = createSystemClock();
  const store = await openJsonlStore(clock, {
    path: path.join(root, 'messaging.jsonl'),
  });
  const messaging = createEmbeddedMessaging({
    clock,
    store,
    authority: {
      principals: [
        {
          token: bearer,
          personId: 'person_secondhost' as PersonId,
          roles: ['Human'],
        },
        {
          token: 'b2a-second-host-recipient',
          personId: 'person_secondrecipient' as PersonId,
          roles: ['Worker'],
        },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  await messaging.start();
  try {
    const senderAuth = await messaging.authenticate({ token: bearer });
    const recipientAuth = await messaging.authenticate({
      token: 'b2a-second-host-recipient',
    });
    if (
      senderAuth.kind !== 'authenticated'
      || recipientAuth.kind !== 'authenticated'
    ) {
      throw new Error('published Messaging authentication failed');
    }
    const sender: MessagingSession = senderAuth.session;
    const recipient: MessagingSession = recipientAuth.session;
    const policy = await recipient.setContactPolicy({
      allowlist: ['person_secondhost'],
      defaultRule: 'deny',
    });
    if (policy.kind !== 'ok') {
      throw new Error(`Messaging policy failed: ${policy.error.message}`);
    }
    const sent = await sender.sendMessage({
      address: 'person:person_secondrecipient',
      body: { text: 'B2a second-host source message' },
      priority: 'normal',
      clientMessageId: 'b2a-second-host-message',
    });
    if (sent.kind !== 'ok') {
      throw new Error(`Messaging send failed: ${sent.error.message}`);
    }
    return sent.value.messageId;
  } finally {
    await messaging.close();
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

  const token = mintToken(
    root,
    'person_secondhost',
    ['project', 'projectItem', 'artifact', 'spine', 'spineStep'],
    'person_local',
  );
  const messageId = await seedMessage(root, token.bearer);
  const project = invokeJson<{ id: string }>(root, token.bearer, [
    'project',
    'create',
    '--title', 'B2a second host',
    '--client-op-id', 'op_second_host_project',
  ]);
  const artifact = invokeJson<{ id: string; byteSize: number }>(
    root,
    token.bearer,
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
    token.bearer,
    ['artifact', 'get-meta', artifact.id],
  );
  const artifactList = invokeJson<{ items: Array<{ id: string }> }>(
    root,
    token.bearer,
    ['artifact', 'list'],
  );
  const artifactBytes = invokeBytes(root, token.bearer, [
    'artifact',
    'get-bytes',
    artifact.id,
  ]);

  const messageWorkflow = invokeJson<SpineWorkflow>(
    root,
    token.bearer,
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
    token.bearer,
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
    token.bearer,
    [
      'spine',
      'status',
      '--workflow', messageWorkflow.workflowId,
    ],
  );
  const artifactStatus = invokeJson<SpineWorkflow>(
    root,
    token.bearer,
    [
      'spine',
      'status',
      '--workflow', artifactWorkflow.workflowId,
    ],
  );

  const continueSourceOp = 'op_second_host_continue_source';
  const interruptedContinue = invoke(
    root,
    token.bearer,
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
    token.bearer,
    ['spine', 'workflows'],
  );
  const toContinue = beforeContinue.items.find(
    ({ originalClientOpId }) => originalClientOpId === continueSourceOp,
  );
  if (!toContinue) throw new Error('accepted continue source was not discovered');
  const continued = invokeJson<SpineWorkflow>(
    root,
    token.bearer,
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
    token.bearer,
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
    token.bearer,
    ['spine', 'workflows'],
  );
  const toAbandon = beforeAbandon.items.find(
    ({ originalClientOpId }) => originalClientOpId === abandonSourceOp,
  );
  if (!toAbandon) throw new Error('accepted abandon source was not discovered');
  const abandoned = invokeJson<SpineWorkflow>(
    root,
    token.bearer,
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
    token.bearer,
    ['project', 'items', '--project', project.id],
  );

  process.stdout.write(`${JSON.stringify({
    root,
    projectId: project.id,
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
    serverStarted: false,
    uiUsed: false,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    code: 'SecondHostProofFailed',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
