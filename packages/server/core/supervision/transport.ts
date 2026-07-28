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
  /** sessionId → the chunks of the turn currently being awaited. */
  const buffers = new Map<string, string[]>();

  // ONE onData registration per runtime, for the process's whole life. A
  // registration per ask() would leak a listener per supervised turn.
  for (const runtime of Object.values(deps.runtimes)) {
    runtime?.onData((key, data) => {
      buffers.get(key)?.push(data);
    });
  }

  return {
    async ask(sessionId, prompt, opts): Promise<AskResult> {
      const provider = await deps.providerOf(sessionId);
      const runtime = provider ? deps.runtimes[provider] : undefined;
      if (!provider || !runtime) {
        return { ok: false, reason: 'unknown-session', text: '' };
      }
      buffers.set(sessionId, []);
      try {
        const sent = await deps.agents.sendToSession(sessionId, prompt);
        if (!sent) return { ok: false, reason: 'send-failed', text: '' };

        let timer: ReturnType<typeof setTimeout> | null = null;
        const timedOut = await Promise.race([
          runtime.drain(sessionId).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), opts?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);

        const text = (buffers.get(sessionId) ?? []).join('');
        if (timedOut) return { ok: false, reason: 'timeout', text };
        // An empty reply is a REFUSAL, not an ok-with-nothing: the skills gate
        // depends on being able to tell "said nothing" from "said the wrong
        // thing", and so does the drift check.
        if (!text.trim()) return { ok: false, reason: 'no-reply', text: '' };
        return { ok: true, text };
      } finally {
        buffers.delete(sessionId);
      }
    },
  };
}
