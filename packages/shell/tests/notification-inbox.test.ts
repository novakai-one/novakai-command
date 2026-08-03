// LANE C — the Shell notification inbox. This is the attention surface, so it
// is held hardest to the house rules rather than excused from them.
//
// The laws under test are the ones a screen can silently break:
//
//   - AT MOST ONE row is the exception, ever. Not "unread rows are marked" —
//     one. A mark on every row is the overstimulating design Chris rejected by
//     name, and it is the failure mode this surface is most prone to.
//   - Settling that row RELEASES the marker. It moves to the next thing that
//     needs him, or the screen goes calm. The release IS the feedback.
//   - The screen never TELLS him where to look. Order and weight do that, so
//     the state words are nouns, never instructions.
//   - Only a Notification the provider has actually seen can be settled — the
//     frozen state machine allows `acknowledged` from `transcript-observed`
//     alone, and the UI must not offer an action the capability will refuse.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  attentionIdOf, awaitingAcknowledgement, formatDelivery, formatState,
  isSettled, orderInbox,
  type NotificationInboxView, type NotificationRowView,
} from '../contract/notifications.js';
import { NotificationInboxView as InboxView } from '../ui/screens/supervision/NotificationInboxScreen.js';

const row = (partial: Partial<NotificationRowView> = {}): NotificationRowView => ({
  id: 'notification_1',
  summary: 'Output token threshold reached',
  state: 'queued',
  deliveryMode: 'start-turn',
  recipient: 'Chris',
  subject: 'agent_kimi',
  at: '2026-08-03T10:00:00.000Z',
  ...partial,
});

const inbox = (rows: NotificationRowView[]): NotificationInboxView => ({
  at: '2026-08-03T10:05:00.000Z', rows,
});

describe('the house gates still hold with the inbox in the viewport', () => {
  it('composes kit components only', () => {
    const out = execFileSync('node', ['tools/lint-kit.mjs'], { encoding: 'utf8' });
    expect(out).toContain('KIT GATE GREEN');
  });

  it('adds NO second attention signal to the composed viewport', () => {
    const out = execFileSync('node', ['tools/lint-accent.mjs'], { encoding: 'utf8' });
    expect(out).toContain('--accent used 1×');
  });
});

describe('exactly one thing is the exception', () => {
  it('marks one row when several are waiting — not all of them', () => {
    const rows = [
      row({ id: 'a', state: 'transcript-observed', at: '2026-08-03T10:00:00.000Z' }),
      row({ id: 'b', state: 'transcript-observed', at: '2026-08-03T10:02:00.000Z' }),
      row({ id: 'c', state: 'transcript-observed', at: '2026-08-03T10:01:00.000Z' }),
    ];
    expect(awaitingAcknowledgement(rows)).toHaveLength(3);
    expect(attentionIdOf(rows)).toBe('b');
  });

  it('settling the marked row releases the marker onto the next one', () => {
    const rows = [
      row({ id: 'a', state: 'transcript-observed', at: '2026-08-03T10:00:00.000Z' }),
      row({ id: 'b', state: 'transcript-observed', at: '2026-08-03T10:02:00.000Z' }),
    ];
    expect(attentionIdOf(rows)).toBe('b');
    const settled = rows.map((r) => (r.id === 'b' ? { ...r, state: 'acknowledged' as const } : r));
    expect(attentionIdOf(settled)).toBe('a');
  });

  it('settling the last one leaves nothing lit — the screen goes calm', () => {
    const rows = [row({ id: 'a', state: 'acknowledged' }), row({ id: 'b', state: 'expired' })];
    expect(attentionIdOf(rows)).toBeNull();
  });

  it('an empty inbox is calm, not an error', () => {
    expect(attentionIdOf([])).toBeNull();
  });
});

describe('the UI never offers an action the capability would refuse', () => {
  it('a queued notification is not awaiting acknowledgement — nothing has seen it', () => {
    expect(awaitingAcknowledgement([row({ state: 'queued' })])).toEqual([]);
  });

  it('a submitted-but-unseen notification is not settleable either', () => {
    expect(awaitingAcknowledgement([row({ state: 'offered-to-endpoint' })])).toEqual([]);
  });

  it('an unconfirmed delivery is not settleable — uncertainty is not observation', () => {
    expect(awaitingAcknowledgement([row({ state: 'delivery-uncertain' })])).toEqual([]);
  });

  it('a queue-only notification can never reach the settleable state', () => {
    // FINDING-C2 rendered honestly: the frozen machine gives queue-only no path
    // to `transcript-observed`, so the inbox shows it and never offers an ack.
    const queueOnly = row({ deliveryMode: 'queue-only', state: 'queued' });
    expect(awaitingAcknowledgement([queueOnly])).toEqual([]);
    expect(attentionIdOf([queueOnly])).toBeNull();
  });
});

describe('order carries the attention, not copy', () => {
  it('puts what needs him first and what is finished last', () => {
    const rows = [
      row({ id: 'settled', state: 'acknowledged' }),
      row({ id: 'queued', state: 'queued' }),
      row({ id: 'seen', state: 'transcript-observed' }),
      row({ id: 'expired', state: 'expired' }),
      row({ id: 'unconfirmed', state: 'delivery-uncertain' }),
      row({ id: 'sent', state: 'offered-to-endpoint' }),
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual([
      'seen', 'unconfirmed', 'sent', 'queued', 'settled', 'expired',
    ]);
  });

  it('breaks ties by recency, newest first', () => {
    const rows = [
      row({ id: 'older', state: 'queued', at: '2026-08-03T09:00:00.000Z' }),
      row({ id: 'newer', state: 'queued', at: '2026-08-03T11:00:00.000Z' }),
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate the rows it was handed', () => {
    const rows = [row({ id: 'a', state: 'queued' }), row({ id: 'b', state: 'transcript-observed' })];
    orderInbox(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('knows what is finished', () => {
    expect(isSettled(row({ state: 'acknowledged' }))).toBe(true);
    expect(isSettled(row({ state: 'expired' }))).toBe(true);
    expect(isSettled(row({ state: 'queued' }))).toBe(false);
  });
});

describe('the words are nouns, never instructions', () => {
  const states: NotificationRowView['state'][] = [
    'queued', 'offered-to-endpoint', 'transcript-observed',
    'acknowledged', 'delivery-uncertain', 'expired',
  ];

  it('states read as facts, one word each', () => {
    for (const state of states) {
      const label = formatState(row({ state }));
      expect(label).not.toBe('');
      expect(label.split(' ')).toHaveLength(1);
    }
  });

  it('no state phrase tells Chris what to do', () => {
    const imperatives = /needs you|click|please|action required|review|check|respond|tap/i;
    for (const state of states) {
      expect(formatState(row({ state }))).not.toMatch(imperatives);
    }
    expect(formatDelivery(row({ deliveryMode: 'queue-only' }))).not.toMatch(imperatives);
  });

  it('every delivery mode has a quiet phrase', () => {
    const modes: NotificationRowView['deliveryMode'][] = [
      'queue-only', 'next-turn-context', 'start-turn',
    ];
    for (const mode of modes) expect(formatDelivery(row({ deliveryMode: mode }))).not.toBe('');
  });
});

describe('the rendered screen', () => {
  it('draws at most one marker no matter how many rows are waiting', () => {
    const rows = [
      row({ id: 'a', state: 'transcript-observed' }),
      row({ id: 'b', state: 'transcript-observed', at: '2026-08-03T10:02:00.000Z' }),
      row({ id: 'c', state: 'transcript-observed', at: '2026-08-03T10:01:00.000Z' }),
    ];
    const html = renderToStaticMarkup(
      React.createElement(InboxView, { inbox: inbox(rows) }),
    );
    expect(html.match(/nv-inbox__row--attention/g) ?? []).toHaveLength(1);
  });

  it('draws no marker at all when everything is settled', () => {
    const html = renderToStaticMarkup(React.createElement(InboxView, {
      inbox: inbox([row({ id: 'a', state: 'acknowledged' })]),
    }));
    expect(html).not.toContain('nv-inbox__row--attention');
  });

  it('says nothing at all when there is nothing — no invented reassurance', () => {
    const html = renderToStaticMarkup(React.createElement(InboxView, { inbox: inbox([]) }));
    expect(html).not.toMatch(/all caught up|nothing needs|you.re all/i);
  });

  it('renders every row it is given, settled ones included', () => {
    const rows = [
      row({ id: 'a', state: 'transcript-observed', summary: 'Drift detected' }),
      row({ id: 'b', state: 'acknowledged', summary: 'Token threshold reached' }),
    ];
    const html = renderToStaticMarkup(
      React.createElement(InboxView, { inbox: inbox(rows) }),
    );
    expect(html).toContain('Drift detected');
    expect(html).toContain('Token threshold reached');
  });

  it('survives a null inbox — the screen is never blank waiting for data', () => {
    const html = renderToStaticMarkup(React.createElement(InboxView, { inbox: null }));
    expect(html).not.toBe('');
  });
});
