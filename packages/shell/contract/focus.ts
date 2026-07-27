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
// S2b (§22 ruling 10): handlers are per (kind, actionId) — an unknown actionId
// on a known kind AND an absent owner both yield typed ActionNotFound.
type ActionHandler = (ref: Ref, actionId: string) => Promise<unknown>;
const actionHandlers = new Map<string, ActionHandler>(); // key: `${kind}·${actionId}`

export function registerActionHandler(kind: string, actionId: string, handler: ActionHandler): void {
  actionHandlers.set(`${kind}·${actionId}`, handler);
}

/** Test/boot seam: clear registered action handlers. */
export function __resetActionHandlers(): void {
  actionHandlers.clear();
}

const actionNotFound = (ref: Ref, actionId: string): ActionNotFoundError => ({
  code: 'ActionNotFound',
  message: `no action handler registered for "${actionId}" on kind "${ref.kind}"`,
  details: { ref, actionId },
  retryable: false,
});

export async function invokeAction(
  ref: Ref,
  actionId: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ActionNotFoundError }> {
  const handler = actionHandlers.get(`${ref.kind}·${actionId}`);
  if (!handler) return { ok: false, error: actionNotFound(ref, actionId) };
  return { ok: true, value: await handler(ref, actionId) };
}
