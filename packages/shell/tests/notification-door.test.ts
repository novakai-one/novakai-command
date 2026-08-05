// B2.5 — the notification surface, moved onto the frozen door (FZ-VIEW-024).
//
// Until this slice the inbox read `ShellServices.getNotificationInbox`, a method
// the Shell invented and only `app/mockServices.ts` implemented. Against a fully
// backed server the screen drew "Supervision is not available in this host"
// forever while `b3.supervision.listNotifications` sat unread (L-14). The row it
// invented also carried seven fields where FZ-VIEW-024 freezes eleven, and one
// of the four it dropped was `phase` — so `drift-human-escalation`, a HUMAN
// being asked to intervene, was indistinguishable from an ordinary condition
// notification on the one screen whose entire job is attention.
//
// These are the laws that survives-a-refactor half of that fix:
//
//   - the copy is the frozen projection, and drift in EITHER direction is loud;
//   - a state this Shell has never heard of is drawn as itself, never as
//     `undefined`, never as settled, and never as settleable;
//   - the escalation phase holds the single attention marker, and
//     `drift-status-request` — which asks the AGENT, not Chris — does not;
//   - the door translates and passes through, and a dead socket is a value.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HUMAN_ESCALATION_PHASE, NOTIFICATION_VIEW_EXTRAS, NOTIFICATION_VIEW_FROZEN,
  attentionIdOf, awaitingAcknowledgement, describeProvenance, describeRecipient,
  describeSubject, formatDelivery, formatState, isHumanEscalation, isSettled,
  orderInbox, type NotificationView,
} from '../contract/notificationRead.js';
import {
  createShellSupervisionServices, notificationDrift, notificationFilterFor,
} from '../app/supervision.js';
import { NotificationInboxView } from '../ui/screens/supervision/NotificationInboxScreen.js';

/** A whole frozen Notification — every field FZ-VIEW-024 names, none invented. */
const notification = (partial: Partial<NotificationView> = {}): NotificationView => ({
  id: 'notification_1',
  createdAt: '2026-08-03T10:00:00.000Z',
  watchRuleId: 'watchrule_nightly',
  subject: { kind: 'agent', agentId: 'agent_kimi' },
  recipient: { kind: 'human', principalId: 'person_chris' },
  conditionGeneration: 4,
  summary: 'Output token threshold reached',
  evidenceRefs: ['usage_evidence_1'],
  state: 'queued',
  deliveryMode: 'start-turn',
  phase: 'condition',
  ...partial,
});

const view = (rows: NotificationView[]) => ({ observedAt: '2026-08-03T10:05:00.000Z', rows });

const html = (rows: NotificationView[] | null) => renderToStaticMarkup(
  React.createElement(NotificationInboxView, {
    inbox: rows === null ? null : view(rows), error: null,
  }),
);

describe('the copy is the frozen projection, and drift is loud both ways', () => {
  it('names every field FZ-VIEW-024 freezes', () => {
    for (const field of [
      'watchRuleId', 'subject', 'recipient', 'conditionGeneration', 'summary',
      'evidenceRefs', 'state', 'deliveryMode', 'phase', 'driftEpisodeId',
    ]) {
      expect(NOTIFICATION_VIEW_FROZEN).toContain(field);
    }
  });

  it('reports a field this copy has never heard of', () => {
    const problems = notificationDrift({ ...notification(), inventedByNobody: true });
    expect(problems.join(' ')).toContain('inventedByNobody');
  });

  it('reports a frozen fact that went missing on the way through', () => {
    const { phase: _dropped, ...withoutPhase } = notification();
    expect(notificationDrift(withoutPhase).join(' ')).toContain('phase');
  });

  it('tolerates the implementation extras BY NAME, so the discrepancy stays visible', () => {
    expect(NOTIFICATION_VIEW_EXTRAS).toContain('deliveryAttempt');
    const withExtras = { ...notification(), deliveryEffectKey: 'k', deliveryAttempt: {} };
    expect(notificationDrift(withExtras)).toEqual([]);
  });
});

describe('a state this Shell has never heard of', () => {
  const unknown = notification({ id: 'strange', state: 'paused-for-review' });

  it('is drawn as itself, never as `undefined`', () => {
    expect(formatState(unknown)).toBe('paused-for-review');
    expect(formatState(unknown)).not.toContain('undefined');
  });

  it('is not settled — the Shell does not decide an unfamiliar state is finished', () => {
    expect(isSettled(unknown)).toBe(false);
  });

  it('is not settleable — the capability accepts an ack from one state only', () => {
    expect(awaitingAcknowledgement([unknown])).toEqual([]);
  });

  it('sorts among the uncertain, not among the finished', () => {
    const rows = [
      notification({ id: 'settled', state: 'acknowledged' }),
      notification({ id: 'sent', state: 'offered-to-endpoint' }),
      unknown,
      notification({ id: 'seen', state: 'transcript-observed' }),
    ];
    expect(orderInbox(rows).map((row) => row.id))
      .toEqual(['seen', 'strange', 'sent', 'settled']);
  });

  it('does not silently become the delivery phrase of another mode', () => {
    expect(formatDelivery(notification({ deliveryMode: 'carrier-pigeon' })))
      .toBe('carrier-pigeon');
  });
});

describe('the escalation phase is the one that means a human is being asked', () => {
  it('tells the two drift phases apart', () => {
    expect(isHumanEscalation(notification({ phase: HUMAN_ESCALATION_PHASE }))).toBe(true);
    // Asks the AGENT for a status, not Chris. Marking it would put the single
    // signal on a row nobody has to do anything about.
    expect(isHumanEscalation(notification({ phase: 'drift-status-request' }))).toBe(false);
    expect(isHumanEscalation(notification({ phase: 'condition' }))).toBe(false);
  });

  it('outranks a condition notification that has already been seen', () => {
    const rows = [
      notification({ id: 'seen', state: 'transcript-observed' }),
      notification({
        id: 'escalation', state: 'queued', phase: HUMAN_ESCALATION_PHASE,
        driftEpisodeId: 'driftepisode_1',
      }),
    ];
    expect(attentionIdOf(rows)).toBe('escalation');
    expect(orderInbox(rows)[0]?.id).toBe('escalation');
  });

  it('still marks exactly ONE row when several humans are being asked', () => {
    const rows = ['a', 'b', 'c'].map((id) => notification({
      id, state: 'queued', phase: HUMAN_ESCALATION_PHASE, driftEpisodeId: 'd',
    }));
    expect(attentionIdOf(rows)).not.toBeNull();
    expect(html(rows).match(/nv-inbox__row--attention/g) ?? []).toHaveLength(1);
  });

  it('releases the marker once the escalation is settled', () => {
    const rows = [
      notification({ id: 'seen', state: 'transcript-observed' }),
      notification({ id: 'escalation', state: 'acknowledged', phase: HUMAN_ESCALATION_PHASE }),
    ];
    expect(attentionIdOf(rows)).toBe('seen');
  });

  it('gives the SENTENCE to the marked row alone — found in a screenshot, not a DOM', () => {
    // Every earlier assertion was green while this screen drew two identical
    // full-ink alarms: the sentence was present, one row carried `--attention`,
    // one mark existed. All true, and the screen still read as two emergencies.
    const rows = ['a', 'b', 'c'].map((id) => notification({
      id, state: 'queued', phase: HUMAN_ESCALATION_PHASE, driftEpisodeId: `drift_${id}`,
    }));
    const out = html(rows);
    expect(out.match(/nv-inbox__escalation/g) ?? []).toHaveLength(1);
    // Quiet, not silent: the unmarked escalations still say what they are, in
    // the provenance tier, and still name their episode.
    expect(out.match(/a human is being asked/g) ?? []).toHaveLength(2);
    expect(out).toContain('drift_b');
  });

  it('says on screen that a human is being asked — the L-14 defect itself', () => {
    const rows = [notification({
      id: 'escalation', state: 'queued', phase: HUMAN_ESCALATION_PHASE,
      driftEpisodeId: 'driftepisode_1',
    })];
    expect(html(rows)).toContain('data-phase="drift-human-escalation"');
    // Distinguishable from an ordinary condition row, which carries no such mark.
    expect(html([notification({ id: 'ordinary' })]))
      .not.toContain('data-phase="drift-human-escalation"');
  });

  it('marks the escalation without offering an ack the capability would refuse', () => {
    // `queued` has no path to `acknowledged`. The row IS the exception, and
    // there is still nothing to settle — both facts, neither traded for the
    // other.
    const queuedEscalation = notification({
      id: 'escalation', state: 'queued', phase: HUMAN_ESCALATION_PHASE,
    });
    expect(attentionIdOf([queuedEscalation])).toBe('escalation');
    expect(awaitingAcknowledgement([queuedEscalation])).toEqual([]);
  });
});

describe('the frozen facts the invented row dropped are on the screen', () => {
  it('draws the subject for every kind the freeze names', () => {
    expect(describeSubject(notification({ subject: { kind: 'agent', agentId: 'agent_k' } })))
      .toContain('agent_k');
    expect(describeSubject(notification({
      subject: { kind: 'agent-run', agentRunId: 'agentrun_9' },
    }))).toContain('agentrun_9');
    expect(describeSubject(notification({
      subject: { kind: 'children-of', agentId: 'agent_k' },
    }))).toContain('children of agent_k');
  });

  it('draws the recipient for both kinds', () => {
    expect(describeRecipient(notification())).toContain('person_chris');
    expect(describeRecipient(notification({
      recipient: { kind: 'agent', agentId: 'agent_fable' },
    }))).toContain('agent_fable');
  });

  it('carries the rule, the generation and the evidence — the justification', () => {
    const provenance = describeProvenance(notification());
    expect(provenance).toContain('watchrule_nightly');
    expect(provenance).toContain('4');
    expect(provenance).toContain('1 evidence');
  });

  it('says "no evidence" out loud rather than drawing nothing', () => {
    expect(describeProvenance(notification({ evidenceRefs: [] }))).toContain('no evidence');
  });
});

describe('the door translates and passes through, and never throws at a screen', () => {
  const doorOver = (respond: (method: string, payload: unknown) => Promise<unknown>) => {
    const seen: { method: string; payload: unknown }[] = [];
    const door = createShellSupervisionServices({
      call: (method, payload) => { seen.push({ method, payload }); return respond(method, payload); },
    });
    return { door, seen };
  };

  it('asks the frozen method, with the published filter', async () => {
    const { door, seen } = doorOver(async () => ({ ok: true, value: { items: [] } }));
    await door.listNotifications({});
    expect(seen[0]?.method).toBe('b3.supervision.listNotifications');
    // `limit` is REQUIRED by the frozen parser — an omitted one is a
    // ValidationFailed, not a default the capability invents for us.
    expect(seen[0]?.payload).toMatchObject({ limit: 200 });
  });

  it('sends no filter member the caller did not name', () => {
    expect(notificationFilterFor({})).toEqual({ limit: 200 });
    expect(notificationFilterFor({ limit: 5, cursor: 'c' })).toEqual({ limit: 5, cursor: 'c' });
  });

  it('hands the page back verbatim — not sorted, not renamed, not re-paged', async () => {
    const items = [notification({ id: 'b' }), notification({ id: 'a' })];
    const { door } = doorOver(async () => ({ ok: true, value: { items } }));
    const answer = await door.listNotifications({});
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value.items.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('settles ONE notification through the frozen mutation', async () => {
    const { door, seen } = doorOver(async () => ({ ok: true, value: notification() }));
    const answer = await door.acknowledge('notification_1');
    expect(seen[0]?.method).toBe('b3.supervision.acknowledge');
    expect(seen[0]?.payload).toEqual({ notificationId: 'notification_1' });
    expect(answer.ok).toBe(true);
  });

  it('turns a refusal into a drawable failure', async () => {
    const { door } = doorOver(async () => ({
      ok: false, error: { code: 'ValidationFailed', message: 'limit out of range' },
    }));
    const answer = await door.listNotifications({});
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe('ValidationFailed');
  });

  it('turns a dead socket into a drawable failure, never an exception', async () => {
    const { door } = doorOver(() => Promise.reject(new Error('socket closed')));
    const answer = await door.listNotifications({});
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.message).toContain('socket closed');
  });

  it('refuses an answer that is not a page of notifications', async () => {
    const { door } = doorOver(async () => ({ ok: true, value: { items: 'lots' } }));
    const answer = await door.listNotifications({});
    expect(answer.ok).toBe(false);
  });
});

describe('the screen still obeys the house rules it was built to obey', () => {
  it('never says "none" before anything has answered', () => {
    expect(html(null)).not.toMatch(/no notifications/i);
  });

  it('draws a failure as a failure, not as an empty inbox', () => {
    const failed = renderToStaticMarkup(React.createElement(NotificationInboxView, {
      inbox: null, error: { code: 'SupervisionUnavailable', message: 'no engine here' },
    }));
    expect(failed).toContain('no engine here');
    expect(failed).not.toMatch(/no notifications/i);
  });

  it('says nothing reassuring when the inbox is genuinely empty', () => {
    expect(html([])).not.toMatch(/all caught up|nothing needs|you.re all/i);
  });

  it('keeps settled rows visible and stops them competing', () => {
    const out = html([
      notification({ id: 'a', state: 'transcript-observed', summary: 'Drift detected' }),
      notification({ id: 'b', state: 'acknowledged', summary: 'Nightly gate passed' }),
    ]);
    expect(out).toContain('Drift detected');
    expect(out).toContain('Nightly gate passed');
    expect(out).toContain('nv-inbox__row--settled');
  });
});
