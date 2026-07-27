// shell/contract/focus.ts + actions.ts — SHL-008 bus plumbing (S1 ships the
// publish seam only; delivery is S2) and invokeAction routing (S2 surface,
// stable signature per §4).
import type { Ref } from './types.js';
import type { ActionNotFoundError } from './errors.js';

export type FocusRef = Ref | 'none';

/** DEC-S2-7: Focus = { app, ref }. Ephemeral — never persisted (C §10). */
export interface FocusState {
  app: string;
  ref: FocusRef;
}

let currentFocus: FocusState = { app: 'messaging', ref: 'none' };
const focusListeners = new Set<(f: FocusState) => void>();

/** Focus refs are {kind,id} or none — never UI paths (B §12). */
export function publishFocus(ref: FocusRef, app = 'messaging'): void {
  currentFocus = { app, ref };
  for (const l of focusListeners) l(currentFocus);
}

export function getFocus(): FocusState {
  return currentFocus;
}

export function subscribeFocus(l: (f: FocusState) => void): () => void {
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
