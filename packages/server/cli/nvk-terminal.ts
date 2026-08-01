#!/usr/bin/env -S npx tsx
// nvk-terminal — list, inspect, attach to, and detach from real terminals (§17.1).
//
//   nvk-terminal list [--state live|final|all]
//   nvk-terminal inspect <terminalSessionId>
//   nvk-terminal open [--cwd <path>] [--authority plain-shell|mock-managed]
//   nvk-terminal attach <terminalSessionId>
//   nvk-terminal detach <controllerAttachmentId> --session <terminalSessionId>
//
// Human output must state BOTH launch origin and current controller truth
// (§17.2) — "no controller attached" is never the same sentence as "stopped".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3err, b3fail, type B3Result, type TerminalSessionId } from '@novakai/foundation/contract';
import type {
  ControllerAttachment, TerminalInputAttempt, TerminalInputLease,
  TerminalOutputFrame, TerminalSession, TerminalSessionView,
} from '../../terminal/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { emit, parseFlags, type Flags } from '../core/b3/cli-shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const [, , command = 'list', ...rest] = process.argv;
const flags = parseFlags(rest);
const root = flags.value('root') ?? process.env['NOVAKAI_ROOT'] ?? path.join(repoRoot, '.novakai');
const port = Number(flags.value('port') ?? process.env['NOVAKAI_RUNTIME_PORT'] ?? 5190);

async function withClient<Value>(
  work: (client: RuntimeClient) => Promise<B3Result<Value>>,
): Promise<B3Result<Value>> {
  let client: RuntimeClient;
  try {
    client = await connectRuntime({ root, port });
  } catch (cause) {
    return b3fail(b3err('RuntimeUnavailable',
      `no Novakai Runtime is reachable on port ${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { reason: 'not-reachable' }, true));
  }
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

function originOf(session: TerminalSession): string {
  return session.owner.kind === 'plain-shell'
    ? `Started as a plain shell (${session.owner.shellInstanceId})`
    : `Started for agent run ${session.owner.agentRunId}`;
}

/**
 * The sentence Chris actually needs. Three separate facts, never collapsed:
 * where it came from, who is watching it now, and whether it is running.
 */
function describeSession(view: TerminalSessionView): string {
  const attached = view.attachments.filter((item) => item.state === 'attached');
  const running = view.session.status === 'live';
  const runningLine = running
    ? 'the terminal is still running in the Novakai Runtime'
    : `the terminal is ${view.session.status}`;
  return `${view.session.id}\n  ${originOf(view.session)}; currently `
    + `${attached.length} controller(s) attached; ${runningLine}.`;
}

function describeList(views: readonly TerminalSessionView[]): string {
  if (views.length === 0) return 'No terminal sessions.';
  return views.map(describeSession).join('\n');
}

/** One handler per command — a table, so adding a verb never grows a branch. */
const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
  async list(argFlags) {
    const state = argFlags.value('state') ?? 'all';
    emit('terminal list', argFlags, await withClient<readonly TerminalSessionView[]>(
      (client) => client.call('b3.terminal.list', { state }),
    ), describeList);
  },

  async inspect(argFlags) {
    const terminalSessionId = argFlags.positional[0] as TerminalSessionId | undefined;
    if (!terminalSessionId) return usage('terminal inspect', argFlags, 'terminalSessionId');
    emit('terminal inspect', argFlags, await withClient<TerminalSessionView>(
      (client) => client.call('b3.terminal.inspect', { terminalSessionId }),
    ), describeSession);
  },

  async open(argFlags) {
    const workingDirectory = argFlags.value('cwd') ?? process.cwd();
    const authority = argFlags.value('authority') ?? 'plain-shell';
    emit('terminal open', argFlags, await withClient<TerminalSession>(
      (client) => client.call('b3.terminal.open', {
        owner: { kind: 'plain-shell', shellInstanceId: `cli-${process.pid}` },
        launchAuthorityRef: authority,
        launchFingerprint: `${authority}:${workingDirectory}`,
        workingDirectory,
        columns: viewportColumns(argFlags),
        rows: viewportRows(argFlags),
      }),
    ), (session) => `${session.id}\n  ${originOf(session)}; currently 0 controller(s) attached; `
      + 'the terminal is running in the Novakai Runtime.');
  },

  async attach(argFlags) {
    const terminalSessionId = argFlags.positional[0] as TerminalSessionId | undefined;
    if (!terminalSessionId) return usage('terminal attach', argFlags, 'terminalSessionId');
    emit('terminal attach', argFlags, await withClient<ControllerAttachment>(
      (client) => client.call('b3.terminal.attach', {
        terminalSessionId,
        controllerKind: 'external-terminal',
        columns: viewportColumns(argFlags),
        rows: viewportRows(argFlags),
      }),
    ), (attachment) => `attached as ${attachment.id}. Closing this window detaches it; `
      + 'the terminal keeps running.');
  },

  async detach(argFlags) {
    const attachmentId = argFlags.positional[0];
    const terminalSessionId = argFlags.value('session') as TerminalSessionId | undefined;
    if (!attachmentId || !terminalSessionId) {
      return usage('terminal detach', argFlags, 'controllerAttachmentId --session <id>');
    }
    emit('terminal detach', argFlags, await withClient<ControllerAttachment>(
      (client) => client.call('b3.terminal.detach', { terminalSessionId, attachmentId }),
    ), (attachment) => `detached ${attachment.id}. The terminal is still running.`);
  },

  async write(argFlags) {
    const terminalSessionId = argFlags.value('session') as TerminalSessionId | undefined;
    const attachmentId = argFlags.value('attachment');
    const text = argFlags.value('text');
    if (!terminalSessionId || !attachmentId || text === undefined) {
      return usage('terminal write', argFlags, '--session <id> --attachment <id> --text <text>');
    }
    emit('terminal write', argFlags, await withClient<TerminalInputAttempt>(
      (client) => sendInput(client, argFlags, { terminalSessionId, attachmentId, text }),
    ), (attempt) => `input #${attempt.inputSequence} ${attempt.outcome}`);
  },

  async read(argFlags) {
    const terminalSessionId = argFlags.positional[0] as TerminalSessionId | undefined;
    if (!terminalSessionId) return usage('terminal read', argFlags, 'terminalSessionId');
    const after = Number(argFlags.value('after') ?? '0');
    emit('terminal read', argFlags, await withClient<readonly TerminalOutputFrame[]>(
      (client) => client.call('b3.terminal.read', {
        terminalSessionId, afterOutputSequence: after,
      }),
    ), (frames) => frames.map(renderFrame).join(''));
  },
};

const viewportColumns = (argFlags: Flags): number =>
  Number(argFlags.value('columns') ?? process.stdout.columns ?? 80);
const viewportRows = (argFlags: Flags): number =>
  Number(argFlags.value('rows') ?? process.stdout.rows ?? 24);

/**
 * Typing means holding the lease, so acquiring it is part of the act: a script
 * can never accidentally interleave with whoever is already typing.
 */
async function sendInput(
  client: RuntimeClient,
  argFlags: Flags,
  target: { terminalSessionId: TerminalSessionId; attachmentId: string; text: string },
): Promise<B3Result<TerminalInputAttempt>> {
  const lease = await client.call<TerminalInputLease>('b3.terminal.acquireLease', {
    terminalSessionId: target.terminalSessionId,
    attachmentId: target.attachmentId,
    mode: 'acquire-if-free',
    ttlMs: 60_000,
  });
  if (!lease.ok) return lease;
  const controlC = argFlags.value('control-c') !== undefined;
  return client.call<TerminalInputAttempt>('b3.terminal.write', {
    terminalSessionId: target.terminalSessionId,
    attachmentId: target.attachmentId,
    inputLeaseId: lease.value.id,
    leaseGeneration: lease.value.generation,
    expectedNextInputSequence: Number(argFlags.value('sequence') ?? '1'),
    kindOfInput: controlC ? 'raw-control-c' : 'text',
    ...(controlC ? {} : { utf8Text: target.text }),
  });
}

async function runCommand(name: string, argFlags: Flags): Promise<never> {
  const handler = COMMANDS[name];
  if (!handler) {
    return usage('terminal', argFlags, 'list|inspect|open|attach|detach|write|read');
  }
  return handler(argFlags);
}

function renderFrame(frame: TerminalOutputFrame): string {
  if (frame.kind === 'bytes') return Buffer.from(frame.base64, 'base64').toString('utf8');
  if (frame.kind === 'gap') {
    return `\n[output between ${String(frame.requestedAfter ?? 0)} and `
      + `${frame.earliestAvailable} is no longer buffered]\n`;
  }
  return `\n[terminal exited${frame.exitCode === undefined ? '' : ` (code ${frame.exitCode})`}]\n`;
}

function usage(command: string, argFlags: Flags, expected: string): never {
  emit(command, argFlags, b3fail(
    b3err('ValidationFailed', `usage: nvk-terminal ${command.split(' ')[1] ?? ''} ${expected}`,
      { issues: [{ path: 'argv', message: `expected ${expected}` }] }, false),
  ), () => '');
}

await runCommand(command, flags);
