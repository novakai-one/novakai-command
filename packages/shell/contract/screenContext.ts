// shell/contract/screenContext.ts — screen-context SUPPORT (FZ-VIEW-016).
//
// This file answers exactly one question: what can THIS Shell capture, and how
// is that said on screen. It deliberately does not touch the other thing the
// same word names.
//
//   the ECHO    — the `ScreenContext` Messaging persisted on a committed
//                 Message and echoes back verbatim on
//                 `AgentCommunicationItem`. FZ-VIEW-014 makes Messaging its
//                 SOLE authority: no Shell view-model recomputes or supplies
//                 it. Nothing here reads it, writes it, or re-derives it.
//   the SUPPORT — what this Shell could capture right now, before any Message
//                 exists. Nobody but the Shell can answer that; it is the
//                 capture authority (orchestrator ACK, 2026-08-06).
//
// FZ-VIEW-016 is a display obligation about the second, drawn in the three
// words the first also uses. Which leads to the trap this file is shaped
// around: browser capture capability can only ever answer `snapshot` or
// `unavailable`. `query-only` has NO v4 operation (freeze §5 P-18) — it can
// only ever arrive as Messaging's echo. So the detector's RETURN TYPE excludes
// it and the label renders all three. A detector that *could* return
// `query-only` would be claiming a capability the Shell does not have, which
// is the same class of lie as B0's false empty: a value invented where the
// authority said nothing.
//
// Pure: no `navigator`, no DOM, no clock. The host reads its own capabilities
// and hands them in (app/captureCapabilities.ts), so a second host — Electron,
// a test, a headless capture — answers for itself without this file changing.

/** FZ-VIEW-015's `support`, all three values, as read on any screen. */
export const SCREEN_CONTEXT_SUPPORT = ['snapshot', 'query-only', 'unavailable'] as const;
export type ScreenContextSupport = (typeof SCREEN_CONTEXT_SUPPORT)[number];

/**
 * The strict subset a capability reading can justify. `Extract` rather than a
 * fresh union, so the two can never drift apart: adding a support value to the
 * freeze's list makes this a compile-time decision, not a silent omission.
 */
export const SHELL_CAPTURE_SUPPORT = ['snapshot', 'unavailable'] as const;
export type ShellCaptureSupport = Extract<ScreenContextSupport, (typeof SHELL_CAPTURE_SUPPORT)[number]>;

/**
 * What the host tells us about itself. One fact, because one fact is all a
 * browser can honestly report: whether display capture exists here at all.
 */
export interface CaptureCapabilities {
  readonly displayCapture: boolean;
}

/** The Shell answering about the Shell. Total, synchronous, no guessing. */
export function detectShellCaptureSupport(capabilities: CaptureCapabilities): ShellCaptureSupport {
  return capabilities.displayCapture ? 'snapshot' : 'unavailable';
}

/**
 * The words FZ-VIEW-016 obliges Raw mode to show. Plain and non-contradictory
 * (FZ-VIEW-034), and never blank: drawing nothing for `unavailable` is the
 * false-empty defect B0 found on the Runs screen, one screen over — absence
 * would read as "no such thing to worry about" when the truth is "an agent
 * cannot see this screen at all".
 */
export function describeScreenContextSupport(support: ScreenContextSupport): string {
  switch (support) {
    case 'snapshot':
      return 'Screen context: snapshot';
    case 'query-only':
      return 'Screen context: query only';
    case 'unavailable':
      return 'Screen context: unavailable';
  }
}
