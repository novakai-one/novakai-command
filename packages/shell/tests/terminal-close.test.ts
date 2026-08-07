// NVK-KIMI-091 B1.6 — FZ-VIEW-033 row 1, the close/quit truth table.
//
// The row: "Close a Novakai terminal tab → Detach Shell controller · must ask
// if live: Keep running / Stop and close / Cancel · Agent/PTY result: keep
// running unless explicit stop", and the row's last clause — a crash reconciles
// to live/interrupted/unknown with NO FALSE CLAIM.
//
// Every case below is a state a real window is in when Chris presses close, and
// each one has a different honest answer. The two the door does NOT have are
// asserted just as hard as the ones it does: a "Stop and close" that detaches is
// the worst defect this surface can ship, because it tells Chris a process is
// gone while it is still running.
import { describe, it, expect } from 'vitest';
import {
  decideTabClose, describeTabCloseClaim, planTabClose, terminalStopPath,
  type TerminalStopDoors,
} from '../contract/terminalClose.js';
import type { TabSessionTruth } from '../contract/terminalTabStrip.js';
import { sessionView as view } from './fixtures/terminalTab.js';

const live = (over: Parameters<typeof view>[0] = {}): TabSessionTruth =>
  ({ known: true, view: view({ status: 'live', ...over }) });
const unknown: TabSessionTruth = { known: false };
/** The host as it actually is today: read-only Runs door, no lifecycle write. */
const NO_DOORS: TerminalStopDoors = { agentRunLifecycle: false };
const WITH_LIFECYCLE: TerminalStopDoors = { agentRunLifecycle: true };

describe('a live session is the one case that must ask', () => {
  it('offers exactly the three choices the row names, in that order', () => {
    const decision = decideTabClose(live(), NO_DOORS);
    expect(decision.mustAsk).toBe(true);
    if (!decision.mustAsk) return;
    expect(decision.choices.map((choice) => choice.id))
      .toEqual(['keep-running', 'stop-and-close', 'cancel']);
  });

  it('Keep running detaches and closes the record — it never stops anything', () => {
    const decision = decideTabClose(live(), NO_DOORS);
    if (!decision.mustAsk) throw new Error('a live session must ask');
    const keep = decision.choices.find((choice) => choice.id === 'keep-running');
    expect(keep?.effect).toBe('detach-and-close');
    expect(keep?.available).toBe(true);
  });

  it('Cancel does nothing at all — not a detach, not a close', () => {
    const decision = decideTabClose(live(), NO_DOORS);
    if (!decision.mustAsk) throw new Error('a live session must ask');
    expect(decision.choices.find((choice) => choice.id === 'cancel')?.effect).toBe('nothing');
  });

  it('says plainly that the session outlives the window', () => {
    const decision = decideTabClose(live(), NO_DOORS);
    expect(decision.claim.kind).toBe('keeps-running');
    expect(describeTabCloseClaim(decision.claim)).toContain('keeps running');
  });
});

describe('Stop and close is only ever offered when a stop is actually reachable', () => {
  it('is UNAVAILABLE for a plain shell, and says why', () => {
    // §13.4: "Terminal termination is available only through Agent Runtime
    // lifecycle authority for managed Agent terminals", and
    // TerminateTerminalInput REQUIRES an agentRunId. A plain shell has none, so
    // no host — however complete — can stop it through the v4 contract.
    const decision = decideTabClose(live({ owner: { kind: 'plain-shell', label: 'novakai-shell' } }), WITH_LIFECYCLE);
    if (!decision.mustAsk) throw new Error('a live session must ask');
    const stop = decision.choices.find((choice) => choice.id === 'stop-and-close');
    expect(stop?.available).toBe(false);
    expect(stop?.unavailableBecause).toMatch(/plain shell/iu);
    // And it must not be silently downgraded into a second detach.
    expect(stop?.effect).toBe('stop-then-close');
  });

  it('is UNAVAILABLE for an agent run while this host has no lifecycle door', () => {
    const decision = decideTabClose(live({ owner: { kind: 'agent-run', label: 'agentRun_7' } }), NO_DOORS);
    if (!decision.mustAsk) throw new Error('a live session must ask');
    const stop = decision.choices.find((choice) => choice.id === 'stop-and-close');
    expect(stop?.available).toBe(false);
    expect(stop?.unavailableBecause).toMatch(/lifecycle/iu);
  });

  it('becomes AVAILABLE for an agent run the moment the lifecycle door exists', () => {
    const decision = decideTabClose(live({ owner: { kind: 'agent-run', label: 'agentRun_7' } }), WITH_LIFECYCLE);
    if (!decision.mustAsk) throw new Error('a live session must ask');
    const stop = decision.choices.find((choice) => choice.id === 'stop-and-close');
    expect(stop?.available).toBe(true);
    expect(stop?.unavailableBecause).toBeNull();
  });

  it('names the route rather than leaving the caller to guess it', () => {
    const path = terminalStopPath(live({ owner: { kind: 'agent-run', label: 'agentRun_7' } }), WITH_LIFECYCLE);
    expect(path).toEqual({ reachable: true, route: 'agent-run-lifecycle' });
  });

  it('has nothing to stop when the Runtime never reported the session', () => {
    const path = terminalStopPath(unknown, WITH_LIFECYCLE);
    expect(path.reachable).toBe(false);
  });
});

describe('a session that is not live is closed without a question', () => {
  it.each(['exited', 'failed'] as const)('%s: nothing to keep running, so nothing to ask', (status) => {
    const decision = decideTabClose({ known: true, view: view({ status }) }, NO_DOORS);
    expect(decision.mustAsk).toBe(false);
    if (decision.mustAsk) return;
    expect(decision.proceed).toBe('detach-and-close');
    expect(decision.claim.kind).toBe('already-ended');
    // The Runtime's own word, verbatim — the Shell does not translate a status
    // into a friendlier one it cannot vouch for.
    expect(describeTabCloseClaim(decision.claim)).toContain(status);
  });

  it.each(['starting', 'reserved'] as const)('%s: closes, and claims nothing either way', (status) => {
    const decision = decideTabClose({ known: true, view: view({ status }) }, NO_DOORS);
    expect(decision.mustAsk).toBe(false);
    if (decision.mustAsk) return;
    expect(decision.claim.kind).toBe('no-claim');
  });
});

describe('the no-false-claim clause', () => {
  it('a session needing recovery is never called running and never called stopped', () => {
    const decision = decideTabClose({ known: true, view: view({ status: 'recovery-required' }) }, NO_DOORS);
    expect(decision.claim.kind).toBe('no-claim');
    const sentence = describeTabCloseClaim(decision.claim);
    expect(sentence).toContain('recovery-required');
    expect(sentence).not.toMatch(/keeps running|has stopped|nothing left/iu);
  });

  it('a session the Runtime cannot account for reads as unaccounted, not as zero', () => {
    const decision = decideTabClose(unknown, NO_DOORS);
    expect(decision.mustAsk).toBe(false);
    if (decision.mustAsk) return;
    expect(decision.proceed).toBe('detach-and-close');
    expect(decision.claim).toEqual({ kind: 'no-claim', status: null });
    expect(describeTabCloseClaim(decision.claim)).toMatch(/cannot account/iu);
  });

  it('every claim renders a non-empty sentence — a blank line is a claim too', () => {
    const claims = [
      decideTabClose(live(), NO_DOORS).claim,
      decideTabClose({ known: true, view: view({ status: 'exited' }) }, NO_DOORS).claim,
      decideTabClose({ known: true, view: view({ status: 'recovery-required' }) }, NO_DOORS).claim,
      decideTabClose(unknown, NO_DOORS).claim,
    ];
    for (const claim of claims) expect(describeTabCloseClaim(claim).trim().length).toBeGreaterThan(20);
  });

  it('an unfamiliar status from a host one version ahead draws as itself', () => {
    // Rule 2 of the copied-door law: the status is `string` on the way in, so a
    // seventh member must render as the word the Runtime used rather than
    // falling into a lookup hole and printing "undefined".
    const decision = decideTabClose(
      { known: true, view: view({ status: 'quiesced' as never }) }, NO_DOORS,
    );
    expect(decision.mustAsk).toBe(false);
    if (decision.mustAsk) return;
    expect(decision.claim.kind).toBe('no-claim');
    expect(describeTabCloseClaim(decision.claim)).toContain('quiesced');
  });
});

describe('what the window actually does with the answer', () => {
  it('Cancel touches nothing — not the Runtime, not the record', () => {
    expect(planTabClose('cancel', true))
      .toEqual({ detach: false, closeRecord: false, stopFirst: false });
  });

  it('Keep running detaches this attachment and closes the record', () => {
    expect(planTabClose('keep-running', true))
      .toEqual({ detach: true, closeRecord: true, stopFirst: false });
  });

  it('a window that never attached still closes the record', () => {
    // The defect this pins: `closeTab` used to return early unless an attachment
    // was held, so a tab whose session had exited (attach fails → nothing held)
    // could not be closed AT ALL. Chris pressed close and the tab stayed, with
    // no message — the worst kind of dead control, on the one status where
    // closing is the only thing left to do.
    expect(planTabClose('keep-running', false))
      .toEqual({ detach: false, closeRecord: true, stopFirst: false });
  });

  it('Stop and close stops FIRST — the record is not closed by a failed stop', () => {
    expect(planTabClose('stop-and-close', true))
      .toEqual({ detach: true, closeRecord: true, stopFirst: true });
  });
});
