// The browser client for b3.terminal.* / b3.runtime.* over nvk-ws v1.
//
// Same origin, same frame, same token as everything else the shell speaks. The
// page is a controller: it can attach, type and leave. It cannot stop anything.
import type {
  TerminalAttachment, TerminalFrame, TerminalOutcome, TerminalServices, TerminalTabView,
} from '../contract/terminalServices.js';
import { fetchBootstrap, type BootstrapDocument } from './serverClient.js';

const PROTOCOL_VERSION = 1;
/** The nvk-ws v1 socket-frame version key. Named because it is one letter. */
const VERSION_FIELD = 'v';

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

interface WireResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

function outcomeOf<Value>(payload: unknown): TerminalOutcome<Value> {
  const result = payload as WireResult | undefined;
  if (!result || typeof result.ok !== 'boolean') {
    return { succeeded: false, code: 'RuntimeUnavailable', message: 'the Runtime returned nothing' };
  }
  if (result.ok) return { succeeded: true, value: result.value as Value };
  return {
    succeeded: false,
    code: result.error?.code ?? 'RuntimeUnavailable',
    message: result.error?.message ?? 'the Runtime refused',
  };
}

export interface TerminalConnection extends TerminalServices {
  /** Live output frames, pushed as ordinary v1 event frames. */
  onOutput(listener: (sessionId: string, frame: TerminalFrame) => void): void;
  close(): void;
}

export async function connectTerminalServices(
  bootstrap?: BootstrapDocument,
): Promise<TerminalConnection> {
  const document_ = bootstrap ?? await fetchBootstrap();
  const socket = new WebSocket(`${document_.wsUrl}?token=${encodeURIComponent(document_.token)}`);
  const pending = new Map<number, Pending>();
  const outputListeners: ((sessionId: string, frame: TerminalFrame) => void)[] = [];
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Runtime did not answer')), 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('the Runtime is not reachable'));
    };
  });

  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as {
      type?: string; name?: string; data?: unknown; id?: number; result?: unknown;
    };
    if (frame.type === 'event' && frame.name === 'b3.terminal.output') {
      const payload = frame.data as {
        terminalSessionId: string;
        frame: { kind: TerminalFrame['kind']; base64?: string; sequence?: number };
      };
      const decoded: TerminalFrame = {
        kind: payload.frame.kind,
        text: payload.frame.base64 === undefined ? '' : decodeBase64(payload.frame.base64),
        ...(payload.frame.sequence === undefined ? {} : { sequence: payload.frame.sequence }),
      };
      for (const listener of outputListeners) listener(payload.terminalSessionId, decoded);
      return;
    }
    if (typeof frame.id !== 'number') return;
    const waiting = pending.get(frame.id);
    if (!waiting) return;
    pending.delete(frame.id);
    waiting.resolve(frame.result);
  };

  function call<Value>(method: string, payload: unknown): Promise<TerminalOutcome<Value>> {
    const id = nextId;
    nextId += 1;
    return new Promise<TerminalOutcome<Value>>((resolve) => {
      pending.set(id, {
        resolve: (answer) => resolve(outcomeOf<Value>(answer)),
        reject: () => undefined,
      });
      socket.send(JSON.stringify({
        id, method, [VERSION_FIELD]: PROTOCOL_VERSION,
        params: { contractVersion: 1, payload },
      }));
    });
  }

  function tabViewOf(stored: unknown): TerminalTabView {
    const view = stored as {
      session: {
        id: string; status: TerminalTabView['status']; workingDirectory: string;
        owner: { kind: string; shellInstanceId?: string; agentRunId?: string };
      };
      attachments: { state: string }[];
      activeInputLease?: unknown;
      replay: { earliestSequence: number; latestSequence: number };
    };
    return {
      terminalSessionId: view.session.id,
      status: view.session.status,
      owner: {
        kind: view.session.owner.kind === 'agent-run' ? 'agent-run' : 'plain-shell',
        label: view.session.owner.agentRunId ?? view.session.owner.shellInstanceId ?? 'shell',
      },
      workingDirectory: view.session.workingDirectory,
      attachedControllerCount: view.attachments.filter((item) => item.state === 'attached').length,
      holdsInputLease: view.activeInputLease !== undefined,
      replay: view.replay,
    };
  }

  return {
    onOutput(listener) { outputListeners.push(listener); },
    close() { socket.close(); },

    async listTerminals() {
      const listed = await call<unknown[]>('b3.terminal.list', { state: 'live' });
      if (!listed.succeeded) return listed;
      return { succeeded: true, value: listed.value.map(tabViewOf) };
    },

    async openTerminal(workingDirectory, columns, rows) {
      const opened = await call<{ id: string }>('b3.terminal.open', {
        owner: { kind: 'plain-shell', shellInstanceId: 'novakai-shell' },
        launchAuthorityRef: 'plain-shell',
        launchFingerprint: `plain-shell:${workingDirectory}`,
        workingDirectory, columns, rows,
      });
      if (!opened.succeeded) return opened;
      const inspected = await call<unknown>('b3.terminal.inspect', {
        terminalSessionId: opened.value.id,
      });
      if (!inspected.succeeded) return inspected;
      return { succeeded: true, value: tabViewOf(inspected.value) };
    },

    async attach(terminalSessionId, columns, rows) {
      const attached = await call<{ id: string }>('b3.terminal.attach', {
        terminalSessionId, controllerKind: 'novakai-shell', columns, rows,
      });
      if (!attached.succeeded) return attached;
      const lease = await call<{ id: string; generation: number }>('b3.terminal.acquireLease', {
        terminalSessionId, attachmentId: attached.value.id,
        mode: 'acquire-if-free', ttlMs: 300_000,
      });
      if (!lease.succeeded) {
        // Someone else is typing. That is a legitimate state, not a failure to
        // attach: this window watches, and says so.
        return {
          succeeded: true,
          value: { attachmentId: attached.value.id, leaseId: '', leaseGeneration: 0 },
        };
      }
      return {
        succeeded: true,
        value: {
          attachmentId: attached.value.id,
          leaseId: lease.value.id,
          leaseGeneration: lease.value.generation,
        },
      };
    },

    async detach(terminalSessionId, attachmentId) {
      const detached = await call<unknown>('b3.terminal.detach', { terminalSessionId, attachmentId });
      return detached.succeeded ? { succeeded: true, value: null } : detached;
    },

    async write(terminalSessionId, attachment, text, sequence) {
      return call<{ inputSequence: number }>('b3.terminal.write', {
        terminalSessionId,
        attachmentId: attachment.attachmentId,
        inputLeaseId: attachment.leaseId,
        leaseGeneration: attachment.leaseGeneration,
        expectedNextInputSequence: sequence,
        kindOfInput: 'text',
        utf8Text: text,
      });
    },

    async resize(terminalSessionId, attachmentId, columns, rows) {
      const resized = await call<unknown>('b3.terminal.resize', {
        terminalSessionId, attachmentId, columns, rows,
      });
      if (!resized.succeeded) return resized;
      return { succeeded: true, value: tabViewOf(resized.value) };
    },

    async readReplay(terminalSessionId, afterOutputSequence) {
      const read = await call<{ kind: string; base64?: string; sequence?: number }[]>(
        'b3.terminal.read', { terminalSessionId, afterOutputSequence },
      );
      if (!read.succeeded) return read;
      return {
        succeeded: true,
        value: read.value.map((frame) => ({
          kind: frame.kind as TerminalFrame['kind'],
          text: frame.base64 === undefined ? '' : decodeBase64(frame.base64),
          ...(frame.sequence === undefined ? {} : { sequence: frame.sequence }),
        })),
      };
    },

    async runtimeStatus() {
      return call('b3.runtime.getStatus', {});
    },
  };
}

function decodeBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
