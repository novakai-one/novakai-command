// core/hooks — hooks engine v1 (S2-pass1 §B + §22 rulings 2/3/9/14).
// Lifecycle events onSpawn/onMessagePre/onMessagePost/onExit; many
// subscriptions per (agentId, event) run in creation (array) order; v1
// actions = log-to-trace + inject-context-text ONLY; every injection fires a
// system.action context.inject trace carrying the injected text; budgets:
// spawn-path 2s, send-path 500ms; timeout/failure = skip + hook_error trace;
// a hook NEVER blocks or fails the host action (DEC-S2-3: liveness wins).
import { mintClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentDefinitionT, HookAction, HookEvent,
} from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

/** §22 ruling 14: spawn-path 2s, send-path 500ms. onExit rides the send-path budget. */
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

/**
 * Execute ONE action: write its trace line; inject-context-text returns the
 * text to merge. Exported so tests can delegate from an executor override.
 */
export async function executeAction(
  ctx: AgentsContext, action: HookAction, refs: HookRefs & { event: HookEvent; agentId: string },
): Promise<string | void> {
  const clientOpId = mintClientOpId(); // system-derived op id per fired action
  const target = { kind: 'agent' as const, id: refs.agentId };
  if (action.kind === 'log-to-trace') {
    await recordSystemAction(ctx.handle, {
      action: 'hook_log', target, clientOpId,
      meta: {
        event: refs.event, message: action.message,
        ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      },
    });
    return undefined;
  }
  // inject-context-text — provenance law (§22 ruling 3): the trace line
  // carries the injected text, auditable forever.
  await recordSystemAction(ctx.handle, {
    action: 'context.inject', target, clientOpId,
    meta: {
      event: refs.event, text: action.text,
      ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      ...(refs.messageText !== undefined ? { message: refs.messageText } : {}),
    },
  });
  return action.text;
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
 * the merged inject-context-text strings (sequential concatenation, §22
 * ruling 2). Never throws: per-hook timeout/failure → skip + hook_error trace.
 */
export async function runEventHooks(
  ctx: AgentsContext,
  agent: AgentDefinitionT,
  event: HookEvent,
  refs: HookRefs = {},
): Promise<{ injections: string[] }> {
  const budgetMs = HOOK_BUDGETS[event];
  const executor = ctx.__hookExecutor ?? ((action: HookAction, r: HookRefs & { event: HookEvent; agentId: string }) => executeAction(ctx, action, r));
  const injections: string[] = [];
  for (const sub of agent.hooks) {
    if (sub.event !== event) continue;
    try {
      const out = await withTimeout(
        Promise.resolve(executor(sub.action, { ...refs, event, agentId: agent.id })),
        budgetMs,
      );
      if (typeof out === 'string') injections.push(out);
    } catch (cause) {
      // timeout or failure: skip the hook, record it, keep going (never-silent
      // law, but liveness wins — DEC-S2-3).
      await recordSystemAction(ctx.handle, {
        action: 'hook_error',
        target: { kind: 'agent', id: agent.id },
        clientOpId: mintClientOpId(),
        meta: {
          event, hookId: sub.id,
          reason: cause instanceof Error ? cause.message : String(cause),
          ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
        },
      });
    }
  }
  return { injections };
}

/** Merge helper: pending (buffered) injections + this event's, then the input. */
export function mergeInput(injections: string[], input: string): string {
  return injections.length > 0 ? `${injections.join('\n')}\n${input}` : input;
}
