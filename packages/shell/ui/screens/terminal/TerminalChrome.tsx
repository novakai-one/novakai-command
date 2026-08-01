// The terminal tab's presentation — everything it draws, and nothing it does.
//
// Split out of TerminalScreen so the chrome is a pure function of what the
// controller knows: it can be rendered and pinned by tests without a PTY, and
// the effectful half is left with no markup to get wrong.
//
// Two standing laws are structural here, not stylistic:
//   - kit only (tools/lint-kit.mjs) — no hand-written markup;
//   - zero accent (tools/lint-accent.mjs) — the composed viewport already has
//     its ONE gold, on the rail. Attention here is ink tier, weight and a rule.
import React from 'react';
import { Button, Stack, Surface, Text } from '../../kit/index.js';
import type { TerminalTabView } from '../../../contract/terminalServices.js';
import './TerminalScreen.css';

/** attention → the session needs a person · settled → it let go · calm → neither. */
export type TerminalTone = 'attention' | 'settled' | 'calm';

/**
 * One signal at a time. A session that needs recovery outranks a settled tab,
 * so the two states can never be drawn at once.
 */
export function toneFor(view: TerminalTabView | null, settled: boolean): TerminalTone {
  if (view?.status === 'recovery-required') return 'attention';
  return settled ? 'settled' : 'calm';
}

export interface TerminalChromeProps {
  /** What the Runtime reports about this session, already in words. */
  readonly truth: string;
  readonly tone: TerminalTone;
  readonly watchingOnly: boolean;
  readonly problem: string | null;
  /** The node xterm draws into — handed straight to the foreign renderer. */
  readonly surfaceRef: React.Ref<HTMLDivElement>;
  readonly onClose: () => void;
}

export function TerminalChrome(props: TerminalChromeProps): React.JSX.Element {
  return (
    <Stack gap={0} className="nvkTerminal" role="region" aria-label="Terminal">
      <Stack horizontal className="nvkTerminalBar">
        <Text className="nvkTerminalTitle">Terminal</Text>
        <Text className="nvkTerminalTruth" data-tone={props.tone} data-testid="terminal-truth">
          {props.truth}
        </Text>
        {/* The only control, and it detaches. A window closing is not a kill
            signal (red gate 1) — there is nothing here that can stop a shell. */}
        <Button className="nvkTerminalButton" data-testid="terminal-close" onClick={props.onClose}>
          Close window
        </Button>
      </Stack>
      <Surface className="nvkTerminalSurface" ref={props.surfaceRef} data-testid="terminal-surface" />
      {props.watchingOnly && (
        <Text as="p" className="nvkTerminalNotice" data-testid="terminal-watching">
          Another window is typing. This one is watching.
        </Text>
      )}
      {props.problem && (
        <Text as="p" className="nvkTerminalNotice" data-tone="problem" data-testid="terminal-problem">
          {props.problem}
        </Text>
      )}
    </Stack>
  );
}
