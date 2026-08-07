// Calm's two numbers (FZ-VIEW-017), and only those two.
//
// It appears when Calm is the mode, which is the point: choosing Calm should
// SHOW what Calm is doing rather than leave the rate to be inferred from the
// output. In Raw there is nothing to pace and the row is not drawn at all.
//
// Three rules, in the order breaking them would hurt:
//
//   TWO INPUTS, FOREVER. FZ-VIEW-018 closed the record's field set, so a preset,
//   a toggle or a smoothing knob would be a control with nowhere to live: it
//   would work until reload and then be gone. A test counts the inputs.
//
//   A VALUE IS COMMITTED, NOT TYPED. Writing on every keystroke would put "2",
//   "20", "200" through the store on the way to 2,000 — three CAS writes, two of
//   them a rate nobody chose, and the first of them refused by the floor. The
//   draft is local; blur and Enter commit it.
//
//   A REFUSED VALUE IS SAID, NEVER CLAMPED. See readPacingChoice: the number on
//   screen must be the number in force.
import React, { useState } from 'react';
import { Field, InlineError, Stack, TextInput } from '../../kit/index.js';
import {
  describePacingRange, readPacingChoice, type CalmPacing, type PacingField,
} from '../../../contract/calmPacing.js';
import { CALM_PACING_LIMITS } from '../../../contract/terminalTab.js';
import './TerminalScreen.css';

export interface TerminalPacingProps {
  readonly pacing: CalmPacing;
  readonly onChange: (pacing: CalmPacing) => void;
}

const FIELDS: readonly PacingField[] = ['revealLinesPerSecond', 'maxBufferedLines'];

export function TerminalPacing(props: TerminalPacingProps): React.JSX.Element {
  /** Only what is mid-edit. Anything not here is read from the record. */
  const [draft, setDraft] = useState<Partial<Record<PacingField, string>>>({});
  const [refused, setRefused] = useState<Partial<Record<PacingField, string>>>({});

  const commit = (field: PacingField): void => {
    const typed = draft[field];
    if (typed === undefined) return;
    const read = readPacingChoice(field, typed);
    if (!read.accepted) {
      setRefused((current) => ({ ...current, [field]: read.because }));
      return;
    }
    setRefused((current) => ({ ...current, [field]: undefined }));
    setDraft((current) => ({ ...current, [field]: undefined }));
    if (read.value === props.pacing[field]) return;
    props.onChange({ ...props.pacing, [field]: read.value });
  };

  return (
    <Stack horizontal gap={18} className="nvkTerminalPacing" data-testid="terminal-pacing">
      {FIELDS.map((field) => (
        <Field key={field} label={describePacingRange(field)}>
          <TextInput
            type="number"
            min={CALM_PACING_LIMITS[field].floor}
            max={CALM_PACING_LIMITS[field].ceiling}
            className="nvkTerminalPacingInput"
            data-testid={`pacing-${field}`}
            value={draft[field] ?? String(props.pacing[field])}
            onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
            onBlur={() => commit(field)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(field);
            }}
          />
          {refused[field] !== undefined && (
            <InlineError>{refused[field]}</InlineError>
          )}
        </Field>
      ))}
    </Stack>
  );
}
