// B3e LANE-B B0 — FZ-VIEW-003's must-show list, made enforceable.
//
// P2 §19.1:3780–3788 says the Agent Run view MUST show seven facts. The tracer
// landed three of them. The other four are landed here, and the list itself is
// turned into a manifest so a future seat cannot quietly drop one and stay
// green.
//
// The hard rule running through every test below: a fact this projection does
// not carry is DRAWN AS MISSING. It is never omitted, never defaulted, and
// never rendered as a zero — "unavailable is not zero" and "no controller is
// not stopped" are the same law applied to two different fields
// (FZ-VIEW-010, FZ-VIEW-034).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AGENT_RUN_MUST_SHOW, describeBackgroundProcess, describeControllers,
  describeFamily, mustShowFact,
} from '../contract/agentRuns.js';
import { RunsView } from '../ui/screens/agents/RunsScreen.js';
import { runRow, pageOf } from './fixtures/agentRunRow.js';

const htmlFor = (view = runRow()): string => renderToStaticMarkup(
  React.createElement(RunsView, { page: pageOf([view]), error: null }),
);

describe('the must-show list is a manifest, not a memory (FZ-VIEW-003)', () => {
  it('carries exactly the seven facts P2 §19.1 names, in its order', () => {
    expect(AGENT_RUN_MUST_SHOW.map((fact) => fact.id)).toEqual([
      'launch-origin',
      'controllers',
      'background-process',
      'activity',
      'family',
      'usage',
      'warnings',
    ]);
  });

  it('marks which facts this projection can actually supply', () => {
    // T-06: the implemented AgentRunView has no `controllers` member, so the
    // Shell renders the GAP rather than a number it does not have.
    expect(mustShowFact('controllers').source).toBe('not-carried');
    expect(AGENT_RUN_MUST_SHOW.filter((fact) => fact.source === 'not-carried'))
      .toHaveLength(1);
  });

  it('draws every fact it claims to carry, for a plain healthy Run', () => {
    const html = htmlFor();
    for (const fact of AGENT_RUN_MUST_SHOW) {
      if (fact.id === 'warnings') continue; // only drawn when there is one
      expect(html, `must-show fact "${fact.id}" is not on screen`)
        .toContain(fact.term);
    }
  });
});

describe('controllers: the gap is drawn, never guessed (T-06, FZ-VIEW-034)', () => {
  it('never prints a controller count, because there is none to print', () => {
    const text = describeControllers(runRow());
    expect(text).not.toMatch(/\d/u);
    expect(text.toLowerCase()).not.toContain('none');
    expect(text.toLowerCase()).not.toContain('no controller');
  });

  it('says plainly that this view does not carry the fact', () => {
    expect(describeControllers(runRow()).toLowerCase()).toContain('not carried');
  });

  it('is on screen for every Run, so the gap cannot be missed', () => {
    expect(htmlFor()).toContain(mustShowFact('controllers').term);
  });
});

describe('background process: liveness comes from finalAt alone', () => {
  // The OQ-07 ruling is explicit — finality is NOT a function of the lifecycle
  // enum, and `run.finalAt` is the one published observable. The Shell keys on
  // the same field `nvk agent list --state` keys on, so the two hosts cannot
  // disagree about who is running.
  it('a Run with no finalAt is still running in the Runtime', () => {
    const text = describeBackgroundProcess(runRow());
    expect(text.toLowerCase()).toContain('running');
    expect(text.toLowerCase()).not.toContain('stopped');
  });

  it('a Run with finalAt has ended, says when in plain UTC, and says why', () => {
    const ended = runRow({
      finalAt: '2026-08-06T02:00:00.000Z', finalReason: 'stopped-by-human',
    });
    const text = describeBackgroundProcess(ended);
    expect(text.toLowerCase()).toContain('ended');
    expect(text).toContain('2026-08-06 02:00 UTC');
    expect(text).toContain('stopped-by-human');
  });

  it('hands back a stamp it cannot parse rather than swallowing it', () => {
    const odd = runRow({ finalAt: 'not-a-timestamp' });
    expect(describeBackgroundProcess(odd)).toContain('not-a-timestamp');
  });

  it('does not read finality off the lifecycle enum', () => {
    // `interrupted` is final only AFTER reconciliation confirms no live
    // provider process (§6.1). A view that called this one ended would be
    // claiming a reconciliation that has not happened.
    const interrupted = runRow({ lifecycle: 'interrupted', activity: 'unknown' });
    expect(describeBackgroundProcess(interrupted).toLowerCase()).toContain('running');
  });

  it('an ended Run still reports where it was started from', () => {
    const html = htmlFor(runRow({ surface: 'external-terminal', finalAt: '2026-08-06T02:00:00.000Z' }));
    expect(html).toContain('Terminal.app');
  });
});

describe('family: parent and current supervisor (FZ-VIEW-003)', () => {
  it('names the human who supervises this Agent today', () => {
    expect(describeFamily(runRow())).toContain('person_chris');
  });

  it('names an agent supervisor by its agent id', () => {
    const text = describeFamily(runRow({
      supervisor: { kind: 'agent', agentId: 'agent_lead' },
    }));
    expect(text).toContain('agent_lead');
  });

  it('an orphaned Agent says so, and says why — it never reads as unsupervised-and-fine', () => {
    const text = describeFamily(runRow({
      supervisor: { kind: 'orphaned', reason: 'supervisor-run-ended' },
    }));
    expect(text.toLowerCase()).toContain('orphaned');
    expect(text).toContain('supervisor-run-ended');
  });

  it('states the parent when there is one, and states its absence when there is not', () => {
    expect(describeFamily(runRow({ parentAgentId: 'agent_parent' })))
      .toContain('agent_parent');
    expect(describeFamily(runRow()).toLowerCase()).toContain('no parent');
  });

  it('a childCount of 0 is a measured zero and may be drawn as one', () => {
    // Unlike usage and controllers, `family.childCount` is a real number the
    // projection carries. Drawing it is honest; hiding it would not be.
    expect(describeFamily(runRow({ childCount: 2 }))).toContain('2');
    expect(describeFamily(runRow()).toLowerCase()).toContain('no children');
  });
});

describe('"we have not asked yet" is not "there are none"', () => {
  // Caught in a real browser, not in a test: clicking Runs against a host with
  // no Runtime showed "No agent runs yet" on 2 of 3 loads and the honest
  // RuntimeUnavailable on the third. Nothing was flaky — the screen simply
  // renders its BEFORE-ANY-ANSWER state as an empty list, and whether you see
  // it depends on how fast you look.
  //
  // It is the same lie as a zero standing in for an unavailable measurement,
  // one component up (FZ-VIEW-010, red gate 4).
  it('renders neither an empty list nor an error before the door has answered', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunsView, { page: null, error: null }),
    );
    expect(html.toLowerCase()).not.toContain('no agent runs');
  });

  it('says it is still reading, so the panel is never blank either', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunsView, { page: null, error: null }),
    );
    expect(html.toLowerCase()).toContain('reading');
  });

  it('an answer of genuinely zero Runs still says so', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunsView, { page: pageOf([]), error: null }),
    );
    expect(html.toLowerCase()).toContain('no agent runs');
  });
});

describe('the row keeps the tracer laws while carrying the new facts', () => {
  it('no controller attached is never rendered as stopped', () => {
    const html = htmlFor();
    expect(html.toLowerCase()).toContain('not carried');
    expect(html.toLowerCase()).not.toContain('stopped');
  });

  it('activity "unknown" survives beside the new liveness line', () => {
    const html = htmlFor(runRow({ activity: 'unknown' }));
    expect(html).toContain('unknown');
    expect(html.toLowerCase()).toContain('running');
  });

  it('warnings are drawn only for the Run that has them', () => {
    expect(htmlFor()).not.toContain(mustShowFact('warnings').term);
    const flagged = htmlFor(runRow({ uncertainty: ['provider-unreachable'] }));
    expect(flagged).toContain(mustShowFact('warnings').term);
    expect(flagged).toContain('provider-unreachable');
  });
});
