// B3e LANE-B B2.3 — the communications view (FZ-VIEW-013, FZ-VIEW-014).
//
// The whole difficulty of this surface is one word appearing twice. B1.4 split
// the two meanings apart in `contract/screenContext.ts`:
//
//   the SUPPORT — what THIS Shell could capture right now. The Shell is the
//                 authority; FZ-VIEW-016 obliges the terminal to display it.
//   the ECHO    — what Messaging persisted on a committed Message and hands
//                 back verbatim. FZ-VIEW-014 makes Messaging the SOLE
//                 authority: "no Shell view-model recomputes or supplies it."
//
// This file is where the second one is read, so the tests below are mostly
// about what the Shell REFUSES to do: it never computes an echo, never fills an
// absent one in from the detector one directory over, never rounds a delivery
// state, never re-orders the owner's page, and never lets a full page read as a
// complete one. The last test is structural rather than behavioural — the two
// meanings must not be able to meet, so the module that renders the echo may
// not import the module that detects support.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMUNICATION_FACTS, COMMUNICATION_VIEW_EXTRAS, COMMUNICATION_VIEW_FROZEN,
  SCREEN_CONTEXT_ECHO_FROZEN, communicationFact, describeDelivery,
  describePageCompleteness, describeParticipants, describeRelatedRuns,
  describeEchoProblems, describeScope, describeScreenContextEcho, screenContextEchoProblems,
} from '../contract/communications.js';
import { agentCommunicationDrift } from '../app/communications.js';
import { CommunicationsView } from '../ui/screens/agents/CommunicationsScreen.js';
import { SCREEN_CONTEXT_SUPPORT, describeScreenContextSupport } from '../contract/screenContext.js';
import {
  communicationItem, communicationsPage, screenContextEcho,
} from './fixtures/communicationItem.js';

const htmlFor = (
  props: Partial<React.ComponentProps<typeof CommunicationsView>> = {},
): string => renderToStaticMarkup(React.createElement(CommunicationsView, {
  page: communicationsPage([communicationItem()]),
  error: null,
  request: { agentIds: ['agent_kimi'], limit: 200 },
  ...props,
}));

const sourceFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('FZ-VIEW-013: the row is the frozen row, field for field', () => {
  it('names exactly the eight members the freeze names', () => {
    expect([...COMMUNICATION_VIEW_FROZEN]).toEqual([
      'messageId', 'threadId', 'senderPrincipalId', 'recipientAgentIds',
      'relatedRunIds', 'deliveryState', 'occurredAt', 'screenContext',
    ]);
  });

  it('keeps the owner-published extras in a SEPARATE list, named', () => {
    // Messaging carries five fields §19.2 needs and FZ-VIEW-013 does not name.
    // They are not smuggled into the frozen list — a reader of this file can
    // see exactly which facts the freeze blessed and which the implementation
    // added, which is the whole question the orchestrator has to rule on.
    expect([...COMMUNICATION_VIEW_EXTRAS]).toEqual([
      'direction', 'inboxState', 'senderAgentId', 'textPreview', 'originBindingId',
    ]);
    for (const extra of COMMUNICATION_VIEW_EXTRAS) {
      expect(COMMUNICATION_VIEW_FROZEN).not.toContain(extra);
    }
  });

  it('reports a field nobody has heard of, in either direction', () => {
    expect(agentCommunicationDrift(communicationItem())).toEqual([]);
    const { threadId: _dropped, ...missing } = communicationItem();
    expect(agentCommunicationDrift(missing).join(' '))
      .toContain('threadId is missing');
    expect(agentCommunicationDrift({ ...communicationItem(), mood: 'chipper' }).join(' '))
      .toContain('mood is not in the frozen projection');
  });

  it('accepts the echo only in the frozen shape', () => {
    expect([...SCREEN_CONTEXT_ECHO_FROZEN]).toEqual([
      'captureId', 'capturedAt', 'source', 'support', 'advisoryOnly',
      'contentRef', 'limitations',
    ]);
    const item = communicationItem({ screenContext: screenContextEcho() });
    expect(agentCommunicationDrift(item)).toEqual([]);
    const invented = {
      ...communicationItem(),
      screenContext: { ...screenContextEcho(), ocrText: 'whatever' },
    };
    expect(agentCommunicationDrift(invented).join(' '))
      .toContain('screenContext.ocrText is not in the frozen projection');
  });
});

describe('FZ-VIEW-014: the echo is read, never supplied', () => {
  it('renders an echoed support value in the same words FZ-VIEW-016 uses', () => {
    for (const support of SCREEN_CONTEXT_SUPPORT) {
      const item = communicationItem({
        screenContext: screenContextEcho({ support, ...(support === 'unavailable' ? { contentRef: undefined } : {}) }),
      });
      expect(describeScreenContextEcho(item))
        .toContain(describeScreenContextSupport(support));
    }
  });

  it('says the field is not carried rather than inventing one', () => {
    // Today's product truth: AMD-004's addition is not implemented anywhere in
    // Messaging, so every real row arrives without it. The Shell draws that gap
    // exactly as B0 draws the missing `controllers` — an absence Chris can see
    // beats a value the Shell made up (CL-S).
    const item = communicationItem();
    expect(item.screenContext).toBeUndefined();
    expect(describeScreenContextEcho(item)).toBe('not carried by this projection');
    expect(communicationFact('screen-context').sourceOf(item)).toBe('not-carried');
  });

  it('does not call a terminal-origin Message a gap', () => {
    // FZ-VIEW-014: a Message committed through CommitTerminalOriginatedMessage
    // HAS no screenContext. That absence is the contract working, not a hole,
    // and the row says which of the two it is looking at.
    const mirrored = communicationItem({ originBindingId: 'transcriptBinding_01J8' });
    expect(describeScreenContextEcho(mirrored)).toContain('mirrored from a transcript');
    expect(communicationFact('screen-context').sourceOf(mirrored)).toBe('frozen');
  });

  it('shows an echo that breaks its own law instead of tidying it away', () => {
    const lying = screenContextEcho({ support: 'unavailable' }); // keeps contentRef
    expect(screenContextEchoProblems(lying).join(' '))
      .toContain('unavailable');
    expect(screenContextEchoProblems(screenContextEcho({ advisoryOnly: false as never })).join(' '))
      .toContain('advisory');
    expect(screenContextEchoProblems(screenContextEcho())).toEqual([]);
    const html = htmlFor({
      page: communicationsPage([communicationItem({ screenContext: lying })]),
    });
    expect(html).toContain('contentRef');
  });

  it('gives the contradiction its OWN line, not the tail of the echo sentence', () => {
    // Found in a screenshot: appended to the support sentence it read as one
    // long muted string — the fact and its refutation at the same ink tier.
    const lying = communicationItem({
      screenContext: screenContextEcho({ support: 'unavailable' }),
    });
    expect(describeScreenContextEcho(lying)).not.toContain('contentRef');
    expect(describeEchoProblems(lying)).toContain('contentRef');
    expect(describeEchoProblems(communicationItem())).toBe('');
    const html = htmlFor({ page: communicationsPage([lying]) });
    expect(html).toContain('Echo problem');
    expect(html).toContain('data-problem="true"');
    // And a healthy row is not marked at all — one exception, or none.
    expect(htmlFor()).toContain('data-problem="false"');
    expect(htmlFor()).not.toContain('Echo problem');
  });

  it('cannot reach the detector: the two meanings never meet', () => {
    // The structural half of "no Shell view-model supplies it". A reviewer can
    // read this rule; a compiler cannot — so the rule is asserted against the
    // source of every module on the echo's path.
    for (const path of [
      '../contract/communications.ts',
      '../ui/screens/agents/CommunicationsScreen.tsx',
      '../app/communications.ts',
    ]) {
      const source = sourceFile(path);
      expect(source, `${path} must not reach the capture detector`)
        .not.toMatch(/detectShellCaptureSupport|captureCapabilities/u);
    }
    // describeScreenContextSupport is a LABEL — it turns a value into words and
    // cannot produce one — so rendering an echo with it is reading, not
    // supplying. That is why the ban is on the detector and not on the label.
    expect(sourceFile('../contract/communications.ts'))
      .toContain('describeScreenContextSupport');
  });
});

describe('the row states what arrived and nothing more', () => {
  it('prints the delivery state verbatim, including one it has never seen', () => {
    expect(describeDelivery(communicationItem({ deliveryState: 'queued' })))
      .toContain('queued');
    expect(describeDelivery(communicationItem({ deliveryState: 'invented-by-a-later-build' })))
      .toContain('invented-by-a-later-build');
  });

  it('never rounds "no Agent recipient" up or down to a count of zero', () => {
    const between = communicationItem({ recipientAgentIds: [] });
    expect(describeParticipants(between)).toContain('person_chris');
    expect(describeParticipants(between)).toContain('no Agent recipient');
    expect(describeParticipants(between)).not.toMatch(/\b0\b/u);
  });

  it('says which Runs a Message touched, and says when it touched none', () => {
    expect(describeRelatedRuns(communicationItem()))
      .toContain('agentRun_01J8ZK4T0000000000000009');
    expect(describeRelatedRuns(communicationItem({ relatedRunIds: [] })))
      .toContain('no Run');
  });

  it('renders the owner\'s order, because paging depends on it', () => {
    // The owner sorts by occurredAt and its cursor names the last row the
    // caller already has. A Shell that re-sorted would page over a list nobody
    // else can see (the same class of error as re-deriving a Run's state).
    const first = communicationItem({ messageId: 'msg_a', occurredAt: '2026-08-06T09:00:00.000Z' });
    const second = communicationItem({ messageId: 'msg_b', occurredAt: '2026-08-06T08:00:00.000Z' });
    const html = htmlFor({ page: communicationsPage([first, second]) });
    expect(html.indexOf('msg_a')).toBeLessThan(html.indexOf('msg_b'));
  });

  it('draws every fact the manifest claims, for a plain row', () => {
    const html = htmlFor();
    const item = communicationItem();
    for (const fact of COMMUNICATION_FACTS) {
      if (fact.describe(item) === '') continue; // nothing to say, nothing drawn
      // A headline fact is the row's status line: the VALUE is on screen, and
      // its label is not repeated below it.
      const looked = fact.headline === true ? fact.describe(item) : fact.term;
      expect(html, `fact "${fact.id}" is not on screen`).toContain(looked);
    }
  });

  it('draws the delivery state once, not twice (found in a screenshot)', () => {
    const html = htmlFor({
      page: communicationsPage([communicationItem({ deliveryState: 'queued', inboxState: 'queued' })]),
    });
    expect(html.split('queued')).toHaveLength(2); // one occurrence, one split
    expect(html).not.toContain('>Delivery<');
  });
});

describe('a full page is not a complete one (L-11)', () => {
  it('says so when the page is exactly as long as the limit', () => {
    // listAgentCommunications slices to `limit` and never sets `nextCursor`,
    // so a truncated list is byte-identical to a complete one. The Shell cannot
    // fix that from here (CL-O), but it can refuse to imply completeness —
    // this sentence is derived from the request the Shell itself made.
    const page = communicationsPage([communicationItem(), communicationItem({ messageId: 'msg_b' })]);
    const said = describePageCompleteness({ agentIds: ['agent_kimi'], limit: 2 }, page);
    expect(said).toContain('2');
    expect(said).toMatch(/may be more/u);
    expect(htmlFor({ page, request: { agentIds: ['agent_kimi'], limit: 2 } }))
      .toMatch(/may be more/u);
  });

  it('says nothing when the page came back short', () => {
    expect(describePageCompleteness(
      { agentIds: ['agent_kimi'], limit: 200 },
      communicationsPage([communicationItem()]),
    )).toBe('');
  });
});

describe('the four states of a list, again (B2.1)', () => {
  it('does not answer "none" before anyone has answered', () => {
    const html = htmlFor({ page: null });
    expect(html).not.toMatch(/No communications/u);
    expect(html).toContain('Reading');
  });

  it('answers none when the owner answered none', () => {
    expect(htmlFor({ page: communicationsPage([]) })).toMatch(/No communications/u);
  });

  it('draws a failure as a failure, never as an empty list', () => {
    const html = htmlFor({
      page: null,
      error: { code: 'RuntimeUnavailable', message: 'no Runtime on this host' },
    });
    expect(html).toContain('RuntimeUnavailable');
    expect(html).not.toMatch(/No communications/u);
  });

  it('names whose communications these are — never "all"', () => {
    const html = htmlFor({ request: { agentIds: ['agent_kimi', 'agent_fable'], limit: 200 } });
    expect(html).toContain('agent_kimi');
    expect(html).toContain('agent_fable');
    expect(html).not.toMatch(/All communications/iu);
  });

  it('never draws half a sentence when there is no scope yet', () => {
    // Found in a screenshot: the no-Runtime path renders before any subject is
    // known, and the screen read "Messages involving" and then stopped.
    expect(describeScope({ agentIds: [] })).toBe('');
    const html = htmlFor({
      page: null,
      request: { agentIds: [] },
      error: { code: 'MessagingUnavailable', message: 'no Runtime on this host' },
    });
    expect(html).not.toContain('Messages involving');
    expect(html).toContain('MessagingUnavailable');
  });
});
