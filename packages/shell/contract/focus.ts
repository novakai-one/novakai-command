// shell/contract/focus.ts + actions.ts — SHL-008 bus plumbing (S1 ships the
// publish seam only; delivery is S2) and invokeAction routing (S2 surface,
// stable signature per §4).
import type { Ref } from './types.js';
import type { ActionNotFoundError } from './errors.js';

export type FocusRef = Ref | 'none';

let currentFocus: FocusRef = 'none';
const focusListeners = new Set<(f: FocusRef) => void>();

/** Focus refs are {kind,id} or none — never UI state (B §12). */
export function publishFocus(ref: FocusRef): void {
  currentFocus = ref;
  for (const l of focusListeners) l(ref);
}

export function getFocus(): FocusRef {
  return currentFocus;
}

export function subscribeFocus(l: (f: FocusRef) => void): () => void {
  focusListeners.add(l);
  return () => focusListeners.delete(l);
}

// ── invokeAction: routed to the owning capability's registered handler ──────
type ActionHandler = (ref: Ref, actionId: string) => Promise<unknown>;
const actionHandlers = new Map<string, ActionHandler>(); // key: kind

export function registerActionHandler(kind: string, handler: ActionHandler): void {
  actionHandlers.set(kind, handler);
}

export async function invokeAction(
  ref: Ref,
  actionId: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ActionNotFoundError }> {
  const handler = actionHandlers.get(ref.kind);
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'ActionNotFound',
        message: `no action handler registered for kind "${ref.kind}"`,
        details: { ref, actionId },
        retryable: false,
      },
    };
  }
  return { ok: true, value: await handler(ref, actionId) };
}
