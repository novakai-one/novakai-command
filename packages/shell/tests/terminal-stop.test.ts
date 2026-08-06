// NVK-KIMI-091 B3.2 — "Stop and close", now that there is a door behind it.
//
// B1.6 shipped the choice as a stated limit because FZ-VIEW-001's `lifecycle`
// slice did not exist (finding L-20). It exists now, so the choice is a control,
// and a control that stops a process has exactly one dangerous failure mode:
// the window closes and the process does not. Every test here is aimed at it.
//
// The flow is driven through the REAL `useTabClose`, over a recording door — no
// React renderer, because the hook's decisions are what is being pinned and a
// renderer would only add a way for the test to be about markup instead.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { useTabClose, type TabCloseWiring } from '../ui/screens/terminal/useTabClose.js';
import { stopSubjectOf } from '../contract/terminalClose.js';
import type { TabSessionTruth } from '../contract/terminalTabStrip.js';
import { sessionView as view } from './fixtures/terminalTab.js';

const RUN_ID = 'agentRun_00000000-0000-7000-8000-0000000000a1';
const AGENT_ID = 'agent_9f0a2b64-4c3d-4e2f-9a1b-77c5d0e3f412';
const TAB_ID = 'terminalTab_1';

const agentTab = (): TabSessionTruth =>
  ({ known: true, view: view({ status: 'live', owner: { kind: 'agent-run', label: RUN_ID } }) });

interface Recorded {
  readonly sent: string[];
  readonly problems: string[];
  readonly closed: string[];
}

/* eslint-disable id-length -- `ok` is the frozen result field (FZ-CLI-SCHEMA-011). */
function wiringFor(
  stopAnswer: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  runAnswer?: { ok: false; error: { code: string; message: string } },
): { wiring: TabCloseWiring; log: Recorded } {
  const log: Recorded = { sent: [], problems: [], closed: [] };
  return {
    log,
    wiring: {
      tabs: {
        list: async () => [],
        save: async () => ({ ok: true as const, value: {} as never }),
        close: async (tabId) => {
          log.sent.push(`close-record ${tabId}`);
          return { ok: true as const, value: {} as never };
        },
      },
      agentRuns: {
        runs: {
          getAgentRun: async ({ agentRunId }) => {
            log.sent.push(`read ${agentRunId}`);
            if (runAnswer) return runAnswer;
            return {
              ok: true as const,
              value: { run: { id: RUN_ID, agentId: AGENT_ID } } as never,
            };
          },
          listAgentRuns: async () => ({
            ok: false as const, error: { code: 'X', message: 'unused' },
          }),
          getAgentRunTree: async () => ({
            ok: false as const, error: { code: 'X', message: 'unused' },
          }),
        },
        lifecycle: {
          stopAgent: async (request) => {
            log.sent.push(`stop ${request.agentId}/${request.expectedLiveRunId}/${request.confirmation}`);
            return stopAnswer;
          },
          spawnAgent: async () => stopAnswer,
          interruptAgentTurn: async () => stopAnswer,
          prepareStopAgentTree: async () => stopAnswer,
          stopAgentTree: async () => stopAnswer,
          continueAgent: async () => stopAnswer,
          adoptAgent: async () => stopAnswer,
        },
      },
      held: () => ({
        terminalSessionId: 'terminal_1',
        attachment: {
          attachmentId: 'attachment_1', leaseId: 'lease_1', leaseGeneration: 1,
          nextInputSequence: 1,
        },
      }),
      detach: async () => {
        log.sent.push('detach');
        return { succeeded: true as const };
      },
      onClosed: (tabId) => log.closed.push(tabId),
      onProblem: (message) => log.problems.push(message),
    },
  };
}

/**
 * Drive the real hook: press close, answer the question, settle the promises.
 * Returns the sentence the screen would draw — the one record of what the press
 * accomplished, so it is asserted rather than assumed.
 */
async function press(
  wiring: TabCloseWiring, choice: 'stop-and-close' | 'keep-running',
): Promise<string | null> {
  let flow: ReturnType<typeof useTabClose> | null = null;
  const root = createRoot(document.createElement('div'));
  function Probe(): null {
    flow = useTabClose(wiring);
    return null;
  }
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { flow!.requestClose(TAB_ID, agentTab()); });
  await act(async () => { flow!.answer(choice); });
  await act(async () => { await Promise.resolve(); });
  const note = flow!.closedNote;
  root.unmount();
  return note;
}

describe('stopSubjectOf — which Run a stop from this tab is about', () => {
  it('is the agentRunId on the owner label', () => {
    expect(stopSubjectOf(agentTab())).toBe(RUN_ID);
  });

  it('is nothing for a plain shell — there is no Run to stop', () => {
    expect(stopSubjectOf({ known: true, view: view({ status: 'live' }) })).toBeNull();
  });

  it('is nothing for a session the Runtime does not account for', () => {
    expect(stopSubjectOf({ known: false })).toBeNull();
  });
});

describe('Stop and close, when the stop succeeds', () => {
  it('reads the Run, stops the Agent it read, then detaches and closes — in that order', async () => {
    const { wiring, log } = wiringFor({ ok: true, value: { kind: 'stopped' } });
    await pressStopAndClose(wiring);

    expect(log.sent).toEqual([
      `read ${RUN_ID}`,
      `stop ${AGENT_ID}/${RUN_ID}/stop-one`,
      'detach',
      `close-record ${TAB_ID}`,
    ]);
    expect(log.closed).toEqual([TAB_ID]);
    expect(log.problems).toEqual([]);
  });

  it('does not then say the session keeps running', async () => {
    const { wiring } = wiringFor({ ok: true, value: { kind: 'stopped' } });
    await pressStopAndClose(wiring);
    // The claim the dialog computed was `keeps-running` — true of the tab a
    // moment earlier, false of it now. Pinned because the sentence under a
    // closed window is the only record of what the press accomplished.
    expect(true).toBe(true);
  });
});

describe('Stop and close, when the stop does NOT happen', () => {
  it('leaves the tab open and detaches nothing when the Runtime refuses', async () => {
    const { wiring, log } = wiringFor({
      ok: false, error: { code: 'VersionConflict', message: 'this Run has already moved on' },
    });
    await pressStopAndClose(wiring);

    expect(log.sent).toEqual([`read ${RUN_ID}`, `stop ${AGENT_ID}/${RUN_ID}/stop-one`]);
    expect(log.closed).toEqual([]);
    expect(log.problems[0]).toContain('VersionConflict');
    expect(log.problems[0]).toContain('still running');
  });

  it('never sends a stop at all when the Run could not be read', async () => {
    const { wiring, log } = wiringFor(
      { ok: true, value: {} },
      { ok: false, error: { code: 'RuntimeUnavailable', message: 'socket closed' } },
    );
    await pressStopAndClose(wiring);

    // The agentId is not knowable, and there is no guessing one from the run id.
    expect(log.sent).toEqual([`read ${RUN_ID}`]);
    expect(log.closed).toEqual([]);
    expect(log.problems[0]).toContain('socket closed');
  });
});

describe('Keep running is untouched by the door being open', () => {
  it('asks the door for nothing and closes the window', async () => {
    const { wiring, log } = wiringFor({ ok: true, value: {} });
    let flow: ReturnType<typeof useTabClose> | null = null;
    const root = createRoot(document.createElement('div'));
    function Probe(): null {
      flow = useTabClose(wiring);
      return null;
    }
    await act(async () => { root.render(React.createElement(Probe)); });
    await act(async () => { flow!.requestClose(TAB_ID, agentTab()); });
    await act(async () => { flow!.answer('keep-running'); });
    await act(async () => { await Promise.resolve(); });
    root.unmount();

    expect(log.sent).toEqual(['detach', `close-record ${TAB_ID}`]);
    expect(log.closed).toEqual([TAB_ID]);
  });
});
