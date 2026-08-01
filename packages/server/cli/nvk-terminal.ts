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
import { emit, EXIT, fail, parseFlags, report, type Flags } from '../core/b3/cli-shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const [, , command = 'list', ...rest] = process.argv;
const flags = parseFlags(rest);
const root = flags.value('root') ?? process.env['NOVAKAI_ROOT'] ?? path.join(repoRoot, '.novakai');
const port = Number(flags.value('port') ?? process.env['NOVAKAI_RUNTIME_PORT'] ?? 5190);

const unreachable = (cause: unknown): ReturnType<typeof b3err> => b3err('RuntimeUnavailable',
  `no Novakai Runtime is reachable on port ${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
  { reason: 'not-reachable' }, true);

async function withClient<Value>(
  work: (client: RuntimeClient) => Promise<B3Result<Value>>,
): Promise<B3Result<Value>> {
  let client: RuntimeClient;
  try {
    client = await connectRuntime({ root, port });
  } catch (cause) {
    return b3fail(unreachable(cause));
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

  /**
   * Attaching is something you DO for as long as you are here, not a record you
   * leave behind: this follows the session's output until you interrupt it, and
   * then detaches. The terminal keeps running — that is the whole point (§13.4).
   */
  async attach(argFlags) {
    const terminalSessionId = argFlags.positional[0] as TerminalSessionId | undefined;
    if (!terminalSessionId) return usage('terminal attach', argFlags, 'terminalSessionId');
    let client: RuntimeClient;
    try {
      client = await connectRuntime({ root, port });
    } catch (cause) {
      return fail('terminal attach', argFlags, unreachable(cause));
    }
    const attached = await client.call<ControllerAttachment>('b3.terminal.attach', {
      terminalSessionId,
      controllerKind: 'external-terminal',
      columns: viewportColumns(argFlags),
      rows: viewportRows(argFlags),
    });
    if (!attached.ok) {
      client.close();
      return emit('terminal attach', argFlags, attached, () => '');
    }
    report('terminal attach', argFlags, attached,
      (attachment) => `attached as ${attachment.id}. Closing this window detaches it; `
        + 'the terminal keeps running. Press Ctrl-C to leave.');

    client.onEvent((name, data) => {
      if (name !== 'b3.terminal.output') return;
      const event = data as { terminalSessionId: string; frame: TerminalOutputFrame };
      if (event.terminalSessionId !== terminalSessionId) return;
      process.stdout.write(renderFrame(event.frame));
    });
    return followUntilInterrupted(client, terminalSessionId, attached.value.id);
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

  /**
   * A one-shot write does not need a window. Without `--attachment` this opens
   * one, types, and closes it again — so a script can never leave a controller
   * behind, and never has to own an attachment id that dies with its socket.
   */
  async write(argFlags) {
    const terminalSessionId = argFlags.value('session') as TerminalSessionId | undefined;
    const attachmentId = argFlags.value('attachment');
    const text = argFlags.value('text');
    if (!terminalSessionId || text === undefined) {
      return usage('terminal write', argFlags, '--session <id> --text <text> [--attachment <id>]');
    }
    emit('terminal write', argFlags, await withClient<TerminalInputAttempt>(
      async (client) => {
        if (attachmentId) {
          return sendInput(client, argFlags, { terminalSessionId, attachmentId, text });
        }
        const attached = await client.call<ControllerAttachment>('b3.terminal.attach', {
          terminalSessionId, controllerKind: 'script',
          columns: viewportColumns(argFlags), rows: viewportRows(argFlags),
        });
        if (!attached.ok) return attached;
        const written = await sendInput(client, argFlags, {
          terminalSessionId, attachmentId: attached.value.id, text,
        });
        // Detaching hands back the lease too, so the next writer is never
        // locked out by a script that has already finished.
        await client.call('b3.terminal.detach', {
          terminalSessionId, attachmentId: attached.value.id,
        });
        return written;
      },
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
  const written = await client.call<TerminalInputAttempt>('b3.terminal.write', {
    terminalSessionId: target.terminalSessionId,
    attachmentId: target.attachmentId,
    inputLeaseId: lease.value.id,
    leaseGeneration: lease.value.generation,
    expectedNextInputSequence: Number(argFlags.value('sequence') ?? '1'),
    kindOfInput: controlC ? 'raw-control-c' : 'text',
    ...(controlC ? {} : { utf8Text: target.text }),
  });
  // A finished script has stopped typing, so it stops holding the keyboard.
  await client.call('b3.terminal.releaseLease', {
    terminalSessionId: target.terminalSessionId,
    attachmentId: target.attachmentId,
    leaseId: lease.value.id,
    generation: lease.value.generation,
  });
  return written;
}

/**
 * Stay attached until the operator leaves, then detach — the CLI's half of
 * "closing a window is detach". A hard kill is covered too: the socket closing
 * is itself a detach, so no path leaves the count wrong.
 */
async function followUntilInterrupted(
  client: RuntimeClient, terminalSessionId: TerminalSessionId, attachmentId: string,
): Promise<never> {
  const leave = async (): Promise<never> => {
    await client.call('b3.terminal.detach', { terminalSessionId, attachmentId });
    client.close();
    process.exit(EXIT.success);
  };
  process.on('SIGINT', () => { void leave(); });
  process.on('SIGTERM', () => { void leave(); });
  await new Promise(() => undefined); // until interrupted
  throw new Error('unreachable');
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
