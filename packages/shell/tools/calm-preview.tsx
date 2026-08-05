// tools/calm-preview.tsx — a dev-only VISUAL proof of Calm mode (FZ-VIEW-017).
//
// The REAL `TerminalChrome` and the REAL `contract/calmPacing.ts` engine, over a
// scripted burst. No PTY, no Runtime, no session — the offline harness starts no
// nvk-server, so the live terminal page cannot boot under it (seat 2's standing
// note), and a second composition faking one is the tracer's law broken.
//
// What this page exists to SHOW rather than assert: that Calm reads as calm.
// A pacer can be arithmetically perfect and still feel like a stutter, and the
// only instrument for that is a person looking at it.
//
// It drives the same three things the screen drives: the mode control writes the
// mode, Raw passes bytes through untouched, and Calm holds a bounded queue and
// releases it on a tick.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalChrome } from '../ui/screens/terminal/TerminalChrome.js';
import {
  emptyCalmState, flushCalm, rawPassthrough, receiveCalm, revealCalm,
  type CalmPacing, type CalmState,
} from '../contract/calmPacing.js';

/** Tight on purpose: the ceiling has to be REACHED for the gap marker to draw. */
const PACING: CalmPacing = { maxBufferedLines: 40, revealLinesPerSecond: 6 };

const BURST = Array.from(
  { length: 120 },
  (_unused, index) => `[build] compiled module ${index + 1} of 120\r\n`,
).join('') + 'chris@novakai ~/Novakai-Command $ ';

function Preview(): React.JSX.Element {
  const [mode, setMode] = React.useState<'raw' | 'calm'>('calm');
  const [shown, setShown] = React.useState('');
  const surface = React.useRef<HTMLDivElement | null>(null);
  const calm = React.useRef<CalmState>(emptyCalmState(Date.now()));
  const modeRef = React.useRef(mode);
  modeRef.current = mode;

  // The burst arrives once, all at once — the case Calm exists for.
  React.useEffect(() => {
    if (modeRef.current === 'raw') {
      setShown(rawPassthrough(BURST));
      return;
    }
    calm.current = receiveCalm(calm.current, BURST, PACING);
  }, []);

  React.useEffect(() => {
    const ticking = setInterval(() => {
      if (modeRef.current !== 'calm') return;
      const { state, text } = revealCalm(calm.current, Date.now(), PACING);
      calm.current = state;
      if (text !== '') setShown((current) => current + text);
    }, 16);
    return () => clearInterval(ticking);
  }, []);

  const change = (next: 'raw' | 'calm'): void => {
    if (next === 'raw') {
      const { state, text } = flushCalm(calm.current);
      calm.current = state;
      setShown((current) => current + text);
    }
    setMode(next);
  };

  // xterm is not loaded here on purpose: this page is proving the PACING, so the
  // released bytes go straight into the chrome's own surface node — exactly what
  // the engine emitted, in order, with no renderer in between to blame.
  const lines = shown.split('\n').filter((line) => line !== '');
  React.useEffect(() => {
    if (surface.current) surface.current.textContent = shown;
  }, [shown]);
  return (
    <>
      <TerminalChrome
        truth={'1 window attached · running'}
        tone="calm"
        tabOpen
        screenContext="unavailable"
        mode={mode}
        onModeChange={change}
        watchingOnly={false}
        problem={null}
        surfaceRef={surface}
        onClose={() => undefined}
      />
      {/* The assertable readout: how many lines have actually been released so
          far. A browser can ask this twice, a second apart, and see the rate. */}
      <pre
        data-testid="paced-output"
        data-lines={String(lines.length)}
        data-mode={mode}
        className="calmPreviewReadout"
      >
        {`${lines.length} of 120 lines released · mode ${mode}`}
      </pre>
    </>
  );
}

createRoot(document.getElementById('preview') as HTMLElement).render(<Preview />);
