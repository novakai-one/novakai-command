// tools/communications-preview.tsx — a dev-only VISUAL proof of the
// communications surface (FZ-VIEW-013/014).
//
// Why it exists: the offline holdout harness starts the Shell's vite server and
// never an nvk-server, so the real Communications screen reaches its honest
// "no Runtime on this host" state and stops. That state IS the truth and is
// captured as evidence — but the rows this slice is about would go to a seal
// unseen.
//
// So: the REAL `CommunicationsView` over literal rows. No fake ShellServices,
// no socket, no second composition — a presentational component rendered with
// known props is not a composition of anything (the tracer's law). It shares
// ONE fixture builder with the deterministic suite
// (tests/fixtures/communicationItem.ts).
//
// The six rows are the six cases worth looking at, and five of them are about
// the ECHO, because the echo is the only field on this row the Shell could be
// tempted to invent.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommunicationsView } from '../ui/screens/agents/CommunicationsScreen.js';
import { communicationItem, communicationsPage, screenContextEcho } from '../tests/fixtures/communicationItem.js';

const rows = [
  // 1. Today's product truth: AMD-004's field is not implemented, so no echo.
  communicationItem({
    messageId: 'msg_01_no_echo',
    textPreview: 'Take the B3e lane B seat and read the freeze first.',
  }),
  // 2. Mirrored out of a terminal — FZ-VIEW-014 says there IS no screenContext.
  communicationItem({
    messageId: 'msg_02_mirrored',
    senderPrincipalId: 'agentRun_019fd000-0000-7000-8000-00000000000a',
    senderAgentId: 'agent_kimi',
    recipientAgentIds: [],
    direction: 'from-agent',
    deliveryState: 'transcript-observed',
    inboxState: 'transcript-observed',
    originBindingId: 'transcriptBinding_019fd000-0000-7000-8000-00000000000b',
    textPreview: 'B1.4 landed — the screen-context obligation draws in both modes.',
    occurredAt: '2026-08-06T09:20:00.000Z',
  }),
  // 3. An echo, as Messaging would send one.
  communicationItem({
    messageId: 'msg_03_snapshot',
    screenContext: screenContextEcho(),
    textPreview: 'Here is what my screen looked like when I asked.',
    occurredAt: '2026-08-06T09:28:00.000Z',
  }),
  // 4. `query-only` — the value a browser can NEVER produce (freeze §5 P-18).
  //    It can only arrive as an echo, which is the whole reason the detector's
  //    return type excludes it and this label still renders it.
  communicationItem({
    messageId: 'msg_04_query_only',
    screenContext: screenContextEcho({ support: 'query-only', contentRef: undefined }),
    textPreview: 'Sent from a host that can be asked about its screen but cannot snapshot it.',
    occurredAt: '2026-08-06T09:31:00.000Z',
  }),
  // 5. An echo that contradicts itself: FZ-VIEW-014 says an `unavailable`
  //    support MUST NOT carry a contentRef. Shown, not tidied away.
  communicationItem({
    messageId: 'msg_05_contradiction',
    screenContext: screenContextEcho({ support: 'unavailable' }),
    textPreview: 'An echo whose support says unavailable while still naming content.',
    occurredAt: '2026-08-06T09:35:00.000Z',
  }),
  // 6. Human to human: no Agent recipient, and no Run touched. Both are real
  //    answers, and neither is drawn as a zero.
  communicationItem({
    messageId: 'msg_06_no_agent',
    recipientAgentIds: [],
    relatedRunIds: [],
    direction: 'between-agents',
    deliveryState: 'delivered',
    inboxState: undefined,
    textPreview: 'A message no Agent was ever given an inbox item for.',
    occurredAt: '2026-08-06T09:40:00.000Z',
  }),
];

function Preview(): React.JSX.Element {
  return (
    <CommunicationsView
      page={communicationsPage(rows)}
      error={null}
      // limit === rows.length on purpose: this is the page that must refuse to
      // read as a complete one (L-11).
      request={{ agentIds: ['agent_kimi', 'agent_fable'], limit: rows.length }}
    />
  );
}

createRoot(document.getElementById('preview')!).render(<Preview />);
