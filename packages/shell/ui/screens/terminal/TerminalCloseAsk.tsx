// The close question (FZ-VIEW-033). Presentation only: it is handed a decision
// and hands back the choice that was made.
//
// Three design rules, all of them the standing laws rather than taste of the
// moment:
//
//   THE FACT COMES FIRST, AND IT IS A FACT. The lead is what Chris is actually
//   deciding with, so it is the full-ink line and the buttons are below it — a
//   dialog that leads with buttons makes him read the buttons to work out the
//   question. It states what is TRUE NOW, never the result of one of the choices:
//   with a reachable Stop below it, "the session keeps running" is the other
//   button's consequence printed above this one (`describeCloseQuestion`).
//
//   THE SAFE CHOICE IS THE EMPHASISED ONE. `Keep running` is the row's DEFAULT
//   result and is the primary; it is also the focused control on open, so a
//   reflex Return keeps the process alive. Nothing here is gold — the composed
//   viewport's one accent lives on the rail (tools/lint-accent.mjs), and this
//   surface earns emphasis with weight and position instead.
//
//   AN UNREACHABLE CHOICE IS TEXT, NOT A DEAD BUTTON. A disabled `Stop and
//   close` is something to press at twice; the limit and its next step are
//   stated in the faint tier where the choice would have been. See
//   contract/terminalClose.ts for why v4 cannot stop a plain shell at all.
import React, { useEffect } from 'react';
import { Button, Stack, Surface, Text } from '../../kit/index.js';
import {
  describeCloseQuestion,
  type TabCloseChoice, type TabCloseChoiceId, type TabCloseDecision,
} from '../../../contract/terminalClose.js';
import './TerminalScreen.css';

export interface TerminalCloseAskProps {
  readonly tabTitle: string;
  /** Only the asking shape renders — `mustAsk: false` never reaches a dialog. */
  readonly decision: Extract<TabCloseDecision, { mustAsk: true }>;
  readonly onChoose: (choice: TabCloseChoiceId) => void;
}

const TEST_ID: Record<TabCloseChoiceId, string> = {
  'keep-running': 'terminal-close-keep',
  'stop-and-close': 'terminal-close-stop',
  cancel: 'terminal-close-cancel',
};

export function TerminalCloseAsk(props: TerminalCloseAskProps): React.JSX.Element {
  // The keyboard's own answer to a question: Escape is Cancel. Bound on the
  // document rather than the dialog node because the press that matters most is
  // the one made before anything inside has been clicked.
  //
  // Focus is `autoFocus` on the primary rather than a ref: the kit's Button is
  // not a forwardRef, and reaching around it for a DOM node is exactly the
  // "screens compose the kit" line (red gate 3). Same effect, no kit change.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onChoose('cancel');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  const unreachable = props.decision.choices.filter(
    (choice: TabCloseChoice) => !choice.available,
  );
  return (
    <Surface
      className="nvkTerminalAsk"
      role="dialog"
      aria-modal="true"
      aria-label={`Close ${props.tabTitle}`}
      data-testid="terminal-close-ask"
    >
      <Stack gap={10}>
        <Text className="nvkTerminalAskTitle">{`Close ${props.tabTitle}`}</Text>
        <Text as="p" className="nvkTerminalAskClaim" data-testid="terminal-close-claim">
          {describeCloseQuestion(props.decision)}
        </Text>
        <Stack horizontal gap={8} className="nvkTerminalAskChoices">
          {props.decision.choices.filter((choice) => choice.available).map((choice) => (
            <Button
              key={choice.id}
              autoFocus={choice.id === 'keep-running'}
              primary={choice.id === 'keep-running'}
              className="nvkTerminalButton"
              data-testid={TEST_ID[choice.id]}
              onClick={() => props.onChoose(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </Stack>
        {unreachable.map((choice) => (
          <Text
            key={choice.id}
            as="p"
            className="nvkTerminalAskLimit"
            data-testid={`${TEST_ID[choice.id]}-unavailable`}
          >
            {`${choice.label} is not available here. ${choice.unavailableBecause ?? ''}`}
          </Text>
        ))}
      </Stack>
    </Surface>
  );
}
