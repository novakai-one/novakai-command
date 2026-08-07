// shell/app/captureCapabilities.ts — the host adapter for FZ-VIEW-016.
//
// The ONE place a browser global is read on the way to a screen-context answer.
// contract/screenContext.ts stays pure so a second host — Electron's main
// process, a headless capture service, a test — answers for itself without that
// file changing; this is the browser's turn to answer.
//
// It takes the host object rather than reaching for `globalThis.navigator`, so
// "what does a host without capture do" is a test rather than a hope. The
// answer to that question is `unavailable`, never a throw: a render with no
// navigator must still be able to say what an agent can see of it, and a
// terminal that dies over a label is a worse bug than the label being grim.
import type { CaptureCapabilities } from '../contract/screenContext.js';

/**
 * The shape actually consulted. Deliberately narrower than `Navigator`: this
 * asks one question, and typing it as the whole navigator would invite the next
 * reader to ask a second one here.
 */
export interface CaptureHost {
  readonly mediaDevices?: { readonly getDisplayMedia?: unknown };
}

/**
 * `getDisplayMedia` is the honest probe. `mediaDevices` is absent entirely in
 * an insecure context, and present-but-incomplete in some embedders — both are
 * `unavailable`, because a capability that might not be there is not one the
 * Shell may report as `snapshot`.
 */
export function readCaptureCapabilities(host: CaptureHost | undefined): CaptureCapabilities {
  return { displayCapture: typeof host?.mediaDevices?.getDisplayMedia === 'function' };
}
