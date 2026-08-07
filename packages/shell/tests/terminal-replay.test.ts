// B1.5, second defect found against a REAL backed host: the boot output was on
// screen TWICE.
//
// History reaches this window down two paths, and until now both wrote:
//
//   the follower  — attaching subscribes to `b3.terminal.output`, and the
//                   Runtime catches the new subscriber up from the beginning;
//   the replay    — `writeReplay(sessionId, 0)` reads the same frames back and
//                   writes them itself.
//
// Whether the duplicate appeared was a RACE: the live listener drops frames
// until `attachedTo` is set, which happens after attach AND acquireLease have
// answered, so on a fast host the catch-up lands first and is dropped, and on a
// slow one it lands after and is drawn. Seat 11 saw both on the same host.
//
// The frames are numbered by the Runtime, so the Shell does not have to guess:
// history that the replay has already written is history, not new output.
import { describe, it, expect } from 'vitest';
import {
  acceptOutputFrame, framesAfterReplay, replayedThrough,
} from '../contract/terminalReplay.js';
import type { TerminalFrame } from '../contract/terminalServices.js';

const bytes = (sequence: number, text = 'x'): TerminalFrame => ({ kind: 'bytes', text, sequence });

describe('output the replay has already written', () => {
  it('is not written a second time by the live stream', () => {
    expect(acceptOutputFrame(bytes(1), 2)).toBe(false);
    expect(acceptOutputFrame(bytes(2), 2)).toBe(false);
  });

  it('lets everything after the replay through', () => {
    expect(acceptOutputFrame(bytes(3), 2)).toBe(true);
  });

  it('lets everything through when nothing has been replayed', () => {
    expect(acceptOutputFrame(bytes(1), 0)).toBe(true);
  });

  /**
   * The dangerous direction. A frame the Runtime did not number cannot be
   * matched against history, and dropping it would lose LIVE output — the one
   * failure mode worse than drawing the banner twice, because a terminal that
   * silently stops showing what the process printed looks like a dead process.
   */
  it('draws a frame the Runtime did not number, rather than dropping it', () => {
    expect(acceptOutputFrame({ kind: 'bytes' }, 9)).toBe(true);
    expect(acceptOutputFrame({ kind: 'exit' }, 9)).toBe(true);
  });
});

describe('how far the replay got', () => {
  it('is the highest sequence it wrote', () => {
    expect(replayedThrough([bytes(1), bytes(2), bytes(3)])).toBe(3);
  });

  it('is nothing when the replay wrote nothing', () => {
    expect(replayedThrough([])).toBe(0);
  });

  it('ignores frames the Runtime did not number', () => {
    expect(replayedThrough([bytes(1), { kind: 'gap', text: '' }, bytes(4)])).toBe(4);
  });

  /**
   * A gap frame is drawn as a stated gap, but it carries no bytes of its own —
   * it must not push the mark past output that never arrived, or the live frames
   * that fill the hole are dropped as "already replayed".
   */
  it('never takes a gap as progress past real output', () => {
    expect(replayedThrough([{ kind: 'gap', text: '' }])).toBe(0);
  });
});

describe('output that arrived while history was being written', () => {
  // The frames cannot be decided when they land — the replay has not answered
  // yet, so "is this history?" has no answer. They are held, then decided.
  it('is drawn once the mark is known, and only the part the replay missed', () => {
    const held = [bytes(2, 'old'), bytes(3, 'new'), bytes(4, 'newer')];
    expect(framesAfterReplay(held, 2)).toEqual([bytes(3, 'new'), bytes(4, 'newer')]);
  });

  it('keeps arrival order — a terminal that reorders its output is worse', () => {
    const held = [bytes(3, 'a'), bytes(4, 'b'), bytes(5, 'c')];
    expect(framesAfterReplay(held, 2).map((frame) => frame.text)).toEqual(['a', 'b', 'c']);
  });

  it('draws nothing when the replay already covered all of it', () => {
    expect(framesAfterReplay([bytes(1), bytes(2)], 2)).toEqual([]);
  });
});
