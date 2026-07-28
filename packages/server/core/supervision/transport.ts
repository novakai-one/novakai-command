// packages/server/core/supervision/transport.ts — how the supervision engine
// ASKS a session something and gets the answer back.
//
// The engine needs a request/response shape ("send this, hand me the reply")
// but the session layer is a stream ("output arrives whenever"). This module is
// the whole adaptation, kept in one place so the engine never learns what a
// provider runtime is.
//
// It sends through the agents contract (so hooks, injections and provenance
// traces all fire exactly as they do for a human message — never stdin
// injection, red gate S2-3), and it takes the reply from the provider runtime's
// own output stream, waiting on `drain()` rather than a sleep: the turn is over
// when the child process is, which is a fact rather than a guess.
import type { ProviderCliRuntime } from '../../../agents/contract/index.js';
import type { ProviderName } from '../../contract/config.js';
import type { AskResult, SupervisedTransport } from './engine.js';

export interface SupervisedTransportDeps {
  agents: { sendToSession(sessionId: string, input: string): Promise<boolean> };
  /** The per-provider CLI runtimes the composition root already built. */
  runtimes: Partial<Record<ProviderName, ProviderCliRuntime>>;
  /** Which provider a session belongs to — the registry knows. */
  providerOf(sessionId: string): Promise<ProviderName | null>;
  /** A turn that never ends must not hang supervision forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // a real build turn can be long

export function createSupervisedTransport(deps: SupervisedTransportDeps): SupervisedTransport {
  interface PendingAsk {
    id: string;
    sessionId: string;
    complete(): void;
    turnDone: Promise<void>;
  }

  /** askId → only that ask's chunks. */
  const buffers = new Map<string, string[]>();
  const asks = new Map<string, PendingAsk>();
  /** Provider output carries sessionId only; provider turn order selects askId. */
  const queues = new Map<string, string[]>();
  /** Preserve call order while provider lookup + send are asynchronous. */
  const dispatchChains = new Map<string, Promise<void>>();
  let nextAskId = 0;

  const removeFromQueue = (sessionId: string, askId: string): void => {
    const queue = queues.get(sessionId);
    if (!queue) return;
    const index = queue.indexOf(askId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) queues.delete(sessionId);
  };

  // ONE onData registration per runtime, for the process's whole life. A
  // registration per ask() would leak a listener per supervised turn.
  for (const runtime of Object.values(deps.runtimes)) {
    runtime?.onData((sessionId, data) => {
      const askId = queues.get(sessionId)?.[0];
      if (askId) buffers.get(askId)?.push(data);
    });
    runtime?.onTurn((record) => {
      const queue = queues.get(record.key);
      const askId = queue?.shift();
      if (!askId) return;
      if (queue?.length === 0) queues.delete(record.key);
      const ask = asks.get(askId);
      asks.delete(askId);
      ask?.complete();
    });
  }

  const dispatchInOrder = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = dispatchChains.get(sessionId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.then(() => undefined, () => undefined);
    dispatchChains.set(sessionId, tail);
    void tail.then(() => {
      if (dispatchChains.get(sessionId) === tail) dispatchChains.delete(sessionId);
    });
    return current;
  };

  return {
    async ask(sessionId, prompt, opts): Promise<AskResult> {
      const askId = `ask_${++nextAskId}`;
      let complete!: () => void;
      const turnDone = new Promise<void>((resolve) => { complete = resolve; });
      const ask: PendingAsk = { id: askId, sessionId, complete, turnDone };

      const dispatched = await dispatchInOrder(sessionId, async () => {
        const provider = await deps.providerOf(sessionId);
        const runtime = provider ? deps.runtimes[provider] : undefined;
        if (!provider || !runtime) return 'unknown-session' as const;

        buffers.set(askId, []);
        asks.set(askId, ask);
        const queue = queues.get(sessionId) ?? [];
        queue.push(askId);
        queues.set(sessionId, queue);

        try {
          const sent = await deps.agents.sendToSession(sessionId, prompt);
          if (sent) return 'sent' as const;
        } catch {
          // The public transport result stays typed as send-failed.
        }
        removeFromQueue(sessionId, askId);
        asks.delete(askId);
        buffers.delete(askId);
        return 'send-failed' as const;
      });

      if (dispatched !== 'sent') {
        return { ok: false, reason: dispatched, text: '' };
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = await Promise.race([
        turnDone.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => resolve(true),
            opts?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);

      const text = (buffers.get(askId) ?? []).join('');
      buffers.delete(askId);
      if (timedOut) {
        // Keep the ask id at the head as a discard sink until onTurn proves
        // this provider turn ended. Its late chunks can never reach the next.
        return { ok: false, reason: 'timeout', text };
      }
      // An empty reply is a REFUSAL, not an ok-with-nothing: the skills gate
      // depends on being able to tell "said nothing" from "said the wrong
      // thing", and so does the drift check.
      if (!text.trim()) return { ok: false, reason: 'no-reply', text: '' };
      return { ok: true, text };
    },
  };
}
