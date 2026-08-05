// The terminal tab strip — which windows are open, and which one you are in.
//
// Calm by default. A healthy tab is its name and nothing else: no dot, no
// count, no chip. Status appears on exactly the rows that have something a
// person has to act on — a session the Runtime cannot account for, and one
// asking for recovery. That is the standing law (ornament belongs to the
// exception) and FZ-VIEW-034 agreeing rather than fighting: the selected
// session's full truth sits in the line beside this strip, always.
//
// Pure presentation. It is handed entries and hands back clicks; the join
// between the durable record and the Runtime's view happened in
// contract/terminalTabStrip.ts, where it can be tested without a DOM.
import React from 'react';
import { Button, ListRow, Stack } from '../../kit/index.js';
import { describeTabSession, type TerminalTabStripEntry } from '../../../contract/terminalTabStrip.js';
import './TerminalScreen.css';

export interface TerminalTabStripProps {
  readonly entries: readonly TerminalTabStripEntry[];
  /** `null` means nothing is selected — drawn as nothing selected, never as tab 1. */
  readonly selectedTabId: string | null;
  readonly onSelect: (tabId: string) => void;
  readonly onNewTab: () => void;
}

/**
 * `unknown` and `attention` are the two rows that earn a mark. Everything else
 * is `quiet` and gets no meta at all — which is what keeps a strip of eight
 * healthy tabs from reading as eight things demanding attention.
 */
type RowSignal = 'quiet' | 'unknown' | 'attention';

function signalFor(entry: TerminalTabStripEntry): RowSignal {
  if (!entry.session.known) return 'unknown';
  const { status } = entry.session.view;
  if (status === 'recovery-required' || status === 'failed') return 'attention';
  if (status === 'exited') return 'unknown';
  return 'quiet';
}

export function TerminalTabStrip(props: TerminalTabStripProps): React.JSX.Element {
  return (
    <Stack horizontal className="nvkTabStrip" role="tablist" aria-label="Terminal tabs">
      {props.entries.map((entry) => {
        const signal = signalFor(entry);
        return (
          <ListRow
            key={entry.tabId}
            className="nvkTabStripRow"
            data-session={signal}
            data-testid={`terminal-tab-${entry.tabId}`}
            label={entry.title}
            // The quiet rows carry no meta node at all, not an empty one.
            meta={signal === 'quiet' ? undefined : describeTabSession(entry)}
            selected={props.selectedTabId === entry.tabId}
            onClick={() => props.onSelect(entry.tabId)}
          />
        );
      })}
      <Button
        className="nvkTerminalButton"
        data-testid="terminal-tab-new"
        onClick={props.onNewTab}
      >
        New tab
      </Button>
    </Stack>
  );
}
