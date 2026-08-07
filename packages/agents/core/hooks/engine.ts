// core/hooks — hooks engine v1 (S2-pass1 §B + §22 rulings 2/3/9/14).
// Lifecycle events onSpawn/onMessagePre/onMessagePost/onExit; many
// subscriptions per (agentId, event) run in creation (array) order; v1
// actions = log-to-trace + inject-context-text ONLY; every injection fires a
// system.action context.inject trace carrying the injected text; budgets:
// spawn-path 2s, send-path 500ms TOTAL per chain (L13 ruling — not per-hook);
// timeout/budget-exhaustion/failure = skip + hook_error trace; a hook NEVER
// blocks or fails the host action (DEC-S2-3: liveness wins).
//
// M7: every recordSystemAction Result is CHECKED — a trace-write failure
// throws inside the hook sandbox → surfaced as a hook_error trace; if even
// that write fails, the failure lands on ctx.hookTraceFailures (never silent).
//
// L14: context.inject provenance traces fire ONLY after the adapter send
// succeeds — executeAction defers them (returns the text + trace payload);
// sendToSession fires them on success and re-buffers the injections on
// failure (an injection that never went out is neither traced nor consumed).
import { mintClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentDefinitionT, HookAction, HookEvent,
} from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

/** §22 ruling 14 + L13: spawn-path 2s, send-path 500ms TOTAL for the whole chain. */
export const HOOK_BUDGETS: Record<HookEvent, number> = {
  onSpawn: 2000,
  onMessagePre: 500,
  onMessagePost: 500,
  onExit: 500,
};

export interface HookRefs {
  sessionId?: string;
  /** The human/agent input this run is attached to (trace refs = agent + message). */
  messageText?: string;
}

/** An injection plus the provenance-trace payload, fired on send success (L14). */
export interface PendingInjection {
  text: string;
  trace: {
    event: HookEvent;
    agentId: string;
    sessionId?: string;
    messageText?: string;
  };
}

/** Record one system.action trace; on failure, surface it (M7 — never silent). */
async function recordChecked(
  ctx: AgentsContext,
  input: Parameters<typeof recordSystemAction>[1],
  failContext: { event: HookEvent; agentId: string; hookId?: string },
): Promise<void> {
  const res = await recordSystemAction(ctx.handle, input);
  if (res.ok) return;
  // Best-effort: surface as a hook_error trace…
  const errRes = await recordSystemAction(ctx.handle, {
    action: 'hook_error',
    target: { kind: 'agent', id: failContext.agentId },
    clientOpId: mintClientOpId(),
    meta: {
      event: failContext.event,
      ...(failContext.hookId ? { hookId: failContext.hookId } : {}),
      reason: `trace write failed for ${input.action}: ${res.error.message}`,
    },
  });
  if (!errRes.ok) {
    // …and if even THAT fails, record it on the context — inspectable, never
    // swallowed; the host action is unaffected (M7's simplest never-silent shape).
    ctx.hookTraceFailures.push({
      event: failContext.event,
      agentId: failContext.agentId,
      reason: `trace write failed for ${input.action}: ${res.error.message}; hook_error trace also failed: ${errRes.error.message}`,
      at: new Date().toISOString(),
    });
  }
}

/**
 * Execute ONE action. log-to-trace writes its trace now (checked, M7 — a
 * failed write throws into the sandbox). inject-context-text DEFERS its
 * provenance trace (L14): returns the PendingInjection; the trace fires only
 * when the send consuming the injection succeeds.
 */
export async function executeAction(
  ctx: AgentsContext, action: HookAction, refs: HookRefs & { event: HookEvent; agentId: string },
): Promise<string | void> {
  const clientOpId = mintClientOpId(); // system-derived op id per fired action
  const target = { kind: 'agent' as const, id: refs.agentId };
  if (action.kind === 'log-to-trace') {
    const res = await recordSystemAction(ctx.handle, {
      action: 'hook_log', target, clientOpId,
      meta: {
        event: refs.event, message: action.message,
        ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      },
    });
    if (!res.ok) throw new Error(`hook_log trace write failed: ${res.error.message}`);
    return undefined;
  }
  // inject-context-text — trace deferred to send success (L14).
  return action.text;
}

/**
 * Fire the deferred provenance trace for ONE injection (L14 + §22 ruling 3):
 * the trace line carries the injected text, auditable forever. Checked (M7).
 */
export async function fireInjectionTrace(ctx: AgentsContext, inj: PendingInjection): Promise<void> {
  await recordChecked(ctx, {
    action: 'context.inject',
    target: { kind: 'agent', id: inj.trace.agentId },
    clientOpId: mintClientOpId(),
    meta: {
      event: inj.trace.event, text: inj.text,
      ...(inj.trace.sessionId ? { sessionId: inj.trace.sessionId } : {}),
      ...(inj.trace.messageText !== undefined ? { message: inj.trace.messageText } : {}),
    },
  }, { event: inj.trace.event, agentId: inj.trace.agentId });
}

function withTimeout<T>(p: Promise<T>, budgetMs: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`hook timeout after ${budgetMs}ms`)), budgetMs);
    }),
  ]);
}

/**
 * Run every subscription of `agent` for `event`, in creation order. Returns
 * the merged inject-context-text entries (sequential concatenation, §22
 * ruling 2) with their deferred provenance traces (L14). Never throws:
 * per-hook timeout/failure → skip + hook_error trace (checked, M7).
 *
 * L13: the budget is TOTAL for the chain — one deadline shared by every hook;
 * once it is gone, remaining hooks are skipped with a hook_error each.
 */
export async function runEventHooks(
  ctx: AgentsContext,
  agent: AgentDefinitionT,
  event: HookEvent,
  refs: HookRefs = {},
): Promise<{ injections: PendingInjection[] }> {
  const budgetMs = HOOK_BUDGETS[event];
  const deadline = Date.now() + budgetMs; // L13: TOTAL chain budget, not per-hook
  const executor = ctx.__hookExecutor ?? ((action: HookAction, r: HookRefs & { event: HookEvent; agentId: string }) => executeAction(ctx, action, r));
  const injections: PendingInjection[] = [];

  const recordHookError = async (hookId: string, reason: string): Promise<void> => {
    const res = await recordSystemAction(ctx.handle, {
      action: 'hook_error',
      target: { kind: 'agent', id: agent.id },
      clientOpId: mintClientOpId(),
      meta: {
        event, hookId, reason,
        ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      },
    });
    if (!res.ok) {
      ctx.hookTraceFailures.push({
        event, agentId: agent.id,
        reason: `hook_error trace write failed: ${res.error.message} (original: ${reason})`,
        at: new Date().toISOString(),
      });
    }
  };

  for (const sub of agent.hooks) {
    if (sub.event !== event) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await recordHookError(sub.id, `chain budget exhausted (${budgetMs}ms total for ${event}) — hook skipped`);
      continue;
    }
    try {
      const out = await withTimeout(
        Promise.resolve(executor(sub.action, { ...refs, event, agentId: agent.id })),
        remaining,
      );
      if (typeof out === 'string') {
        injections.push({
          text: out,
          trace: {
            event, agentId: agent.id,
            ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
            ...(refs.messageText !== undefined ? { messageText: refs.messageText } : {}),
          },
        });
      }
    } catch (cause) {
      // timeout or failure: skip the hook, record it, keep going (never-silent
      // law, but liveness wins — DEC-S2-3).
      await recordHookError(sub.id, cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { injections };
}

/** Merge helper: pending (buffered) injections + this event's, then the input. */
export function mergeInput(injections: Array<string | PendingInjection>, input: string): string {
  const texts = injections.map((i) => (typeof i === 'string' ? i : i.text));
  return texts.length > 0 ? `${texts.join('\n')}\n${input}` : input;
}
