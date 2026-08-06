// tests/raw-input.test.ts — FZ-VIEW-032's Raw clause at the keystroke.
//
// The defect these pin: `screen.onData` returned silently when this window held
// no attachment or no lease. Typing did nothing and said nothing, which is
// indistinguishable from a hung process.
import { describe, it, expect } from 'vitest';
import { decideRawInput, makeRawInputHandler, rawInputNotice } from '../ui/screens/terminal/rawInput.js';
import type { TerminalAttachment } from '../contract/terminalServices.js';

const leased: TerminalAttachment = {
  attachmentId: 'att_1', leaseId: 'lease_1', leaseGeneration: 1, nextInputSequence: 1,
};
const readOnly: TerminalAttachment = { ...leased, leaseId: '' };

const ctx = (over: Partial<Parameters<typeof decideRawInput>[1]> = {}) => ({
  attachment: leased as TerminalAttachment | null,
  sessionId: 'ts_1' as string | null,
  alreadyAnnounced: false,
  ...over,
});

describe('Raw input under the lease', () => {
  it('a held lease sends the bytes unchanged', () => {
    const d = decideRawInput('/compact  ', ctx());
    expect(d).toEqual({ send: '/compact  ', announce: null });
  });

  it('control bytes are not treated as text and not reshaped', () => {
    // Ctrl-C is ordinary ordered terminal input (P2 §13.3:3085). A parser in
    // this path would be the exact thing FZ-VIEW-032 forbids.
    const ctrlC = String.fromCharCode(3);
    expect(decideRawInput(ctrlC, ctx()).send).toBe(ctrlC);
  });

  it('no attachment: nothing is sent, and it SAYS so', () => {
    const d = decideRawInput('ls', ctx({ attachment: null }));
    expect(d.send).toBeNull();
    expect(d.announce).not.toBeNull();
    expect(d.announce).toContain('no write lease');
    // no attachment is NOT a rival controller — that was a false claim drawn
    // over an exited session in b31-9.
    expect(d.announce).toContain('Nothing is attached here');
    expect(d.announce!.toLowerCase()).not.toContain('another window');
  });

  it('an attachment with no lease names the rival, because there is one', () => {
    const d = decideRawInput('ls', ctx({ attachment: readOnly }));
    expect(d.send).toBeNull();
    expect(d.announce).toContain('Another window is typing');
  });

  it('no session is a refusal, never a write against a null id', () => {
    expect(decideRawInput('ls', ctx({ sessionId: null })).send).toBeNull();
  });

  it('the refusal is drawn once per blocked run, not per keystroke', () => {
    const first = decideRawInput('l', ctx({ attachment: null }));
    const second = decideRawInput('s', ctx({ attachment: null, alreadyAnnounced: true }));
    expect(first.announce).not.toBeNull();
    expect(second.announce).toBeNull();
    expect(second.send).toBeNull();
  });

  it('the notice is its own line, never mixed into program output', () => {
    expect(rawInputNotice('nothing was sent')).toBe('\r\n[nothing was sent]\r\n');
  });
});

describe('the keystroke handler the screen registers', () => {
  const harness = (attached: TerminalAttachment | null) => {
    const written: Array<{ text: string; sequence: number }> = [];
    const drawn: string[] = [];
    const refs = {
      attachment: { current: attached },
      attachedTo: { current: attached === null ? null : 'ts_1' },
      inputSequence: { current: 7 },
      blockedAnnounced: { current: false },
    };
    const handler = makeRawInputHandler({
      services: {
        write: async (_id: string, _att: TerminalAttachment, text: string, sequence: number) => {
          written.push({ text, sequence });
          return { succeeded: true as const, value: { inputSequence: sequence + 1 } };
        },
      } as never,
      write: (text: string) => { drawn.push(text); },
      refresh: async () => [],
      onProblem: () => undefined,
      refs,
    });
    return { handler, written, drawn, refs };
  };

  it('sends the bytes unchanged and advances the sequence', () => {
    const h = harness(leased);
    h.handler('/compact');
    expect(h.written).toEqual([{ text: '/compact', sequence: 7 }]);
    expect(h.refs.inputSequence.current).toBe(8);
  });

  it('with no lease it writes the notice and nothing goes on the wire', () => {
    const h = harness(null);
    h.handler('ls');
    expect(h.written).toEqual([]);
    expect(h.drawn).toHaveLength(1);
    expect(h.drawn[0]).toMatch(/^\r\n\[.*\]\r\n$/);
    // and the second keystroke does not repeat it
    h.handler('l');
    expect(h.drawn).toHaveLength(1);
  });
});
