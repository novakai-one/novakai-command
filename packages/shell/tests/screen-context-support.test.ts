// NVK-KIMI-091 B1.4 — FZ-VIEW-016: Raw mode MUST display whether screen context
// is snapshot, query-only or unavailable.
//
// The whole difficulty of this row is that TWO different things are named by
// the same word, and conflating them is the failure mode:
//
//   the ECHO      — the `ScreenContext` Messaging persisted on a committed
//                   Message and echoes back verbatim. Messaging is its sole
//                   authority (FZ-VIEW-014) and the Shell never recomputes it.
//   the SUPPORT   — what THIS Shell can capture right now, before any Message
//                   exists. The Shell is the capture authority; nobody else can
//                   answer it, and the orchestrator ACKed that reading on
//                   2026-08-06.
//
// So the Shell may detect its own capture support and must not invent an echo.
// And there is a second trap inside that: browser capture capability can only
// ever answer `snapshot` or `unavailable`. `query-only` has NO v4 operation
// (freeze §5 P-18) — it can only arrive as an echo from Messaging. A detector
// that could return it would be fabricating a capability the Shell does not
// have, so the detector's RETURN TYPE excludes it, while the label renders all
// three.
import { describe, it, expect } from 'vitest';
import {
  SHELL_CAPTURE_SUPPORT,
  SCREEN_CONTEXT_SUPPORT,
  detectShellCaptureSupport,
  describeScreenContextSupport,
  type ScreenContextSupport,
} from '../contract/screenContext.js';
import { readCaptureCapabilities } from '../app/captureCapabilities.js';

describe('what this Shell can capture — the Shell answering about itself', () => {
  it('reports snapshot when the host can capture the display', () => {
    expect(detectShellCaptureSupport({ displayCapture: true })).toBe('snapshot');
  });

  it('reports unavailable when it cannot — never silence, never a guess', () => {
    expect(detectShellCaptureSupport({ displayCapture: false })).toBe('unavailable');
  });

  it('cannot answer query-only, over its ENTIRE input domain', () => {
    // The domain is one boolean, so this is exhaustive rather than a sample:
    // there is no capability reading that makes the Shell claim an operation
    // the v4 contract does not have (P-18).
    const everyAnswer = [true, false].map((displayCapture) =>
      detectShellCaptureSupport({ displayCapture }));
    expect(everyAnswer).not.toContain('query-only');
    expect(SHELL_CAPTURE_SUPPORT).toEqual(['snapshot', 'unavailable']);
  });
});

describe('the host adapter — the one place a browser global is read', () => {
  it('a host that can capture the display reports the capability', () => {
    const host = { mediaDevices: { getDisplayMedia: () => Promise.resolve(null) } };
    expect(readCaptureCapabilities(host)).toEqual({ displayCapture: true });
    expect(detectShellCaptureSupport(readCaptureCapabilities(host))).toBe('snapshot');
  });

  it('an insecure context has no mediaDevices at all, and that is unavailable', () => {
    expect(readCaptureCapabilities({})).toEqual({ displayCapture: false });
  });

  it('mediaDevices without getDisplayMedia is still unavailable, not assumed', () => {
    expect(readCaptureCapabilities({ mediaDevices: {} })).toEqual({ displayCapture: false });
  });

  it('no host at all answers unavailable instead of throwing', () => {
    // A render with no `navigator` (a test, a server render, a stripped
    // embedder) must still be able to say what it can see. Throwing here would
    // take the whole terminal down over a question about a label.
    expect(readCaptureCapabilities(undefined)).toEqual({ displayCapture: false });
    expect(detectShellCaptureSupport(readCaptureCapabilities(undefined))).toBe('unavailable');
  });
});

describe('the three states FZ-VIEW-016 obliges Raw mode to display', () => {
  it('names all three, including the one the Shell can never detect', () => {
    // `query-only` reaches a screen only as Messaging's echo. The label must
    // still render it: a Shell that draws a blank for a state it did not
    // produce is exactly the false-empty defect B0 found on the Runs screen.
    expect(SCREEN_CONTEXT_SUPPORT).toEqual(['snapshot', 'query-only', 'unavailable']);
    for (const support of SCREEN_CONTEXT_SUPPORT) {
      expect(describeScreenContextSupport(support).trim()).not.toBe('');
    }
  });

  it('gives each state its own words — two states never read the same', () => {
    const said = SCREEN_CONTEXT_SUPPORT.map(describeScreenContextSupport);
    expect(new Set(said).size).toBe(SCREEN_CONTEXT_SUPPORT.length);
  });

  it('says which of the three it is, in plain words', () => {
    expect(describeScreenContextSupport('snapshot')).toBe('Screen context: snapshot');
    expect(describeScreenContextSupport('query-only')).toBe('Screen context: query only');
    expect(describeScreenContextSupport('unavailable')).toBe('Screen context: unavailable');
  });

  it('never draws unavailable as absence — the label exists in all three states', () => {
    const unavailable: ScreenContextSupport = 'unavailable';
    expect(describeScreenContextSupport(unavailable)).toContain('unavailable');
  });
});
