// shell/ui/screens/supervision/NotificationInboxScreen.tsx — the notification
// inbox (FZ-VIEW-024), read through FZ-VIEW-001's `supervision` door.
// Kit-composed ONLY (red gate 3).
//
// This is the screen whose entire job is managing attention, which makes it the
// screen most able to get it wrong. It obeys the house rules literally:
//
//   - ONE row is the exception at a time. Not "the unread ones" — one. The mark
//     is a liveness dot, never the accent (R3-25, SHL-010): the composed
//     viewport already spends its single gold, and this screen does not ask for
//     a second one.
//   - Settling that row RELEASES the mark onto the next thing that needs him,
//     and settling the last leaves the screen calm. The release is the feedback;
//     no toast, no confirmation copy.
//   - Order carries the attention. Nothing on this screen tells Chris where to
//     look — with ONE exception, added in B2.5 and argued for there: a
//     `drift-human-escalation` is Supervision saying a human is being asked to
//     intervene, and no amount of ordering can express *that* a request is
//     addressed to him. It is the single full-ink line on the screen.
//   - Settled rows stay visible and stop competing — dimmed, in place, so the
//     inbox reads as a record rather than a queue that eats its own history.
//
// The shell holds no notification truth: rows arrive from Supervision through
// the frozen door and are shown as measured. The only action offered is the one
// the frozen state machine actually accepts — an acknowledgement of a
// Notification the provider has been observed to receive — and the capability,
// not this screen, is what enforces that.
import React, { useCallback, useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import {
  attentionIdOf, awaitingAcknowledgement, describeRowFacts, formatRowMeta,
  inboxCompleteness, isHumanEscalation, isSettled, orderInbox,
  type NotificationInboxView as InboxData, type NotificationView,
} from '../../../contract/notificationRead.js';
import { answerFrom, type AnswerFailure } from '../../../contract/listAnswer.js';
import {
  EmptyState, InlineError, ListRow, Panel, PresenceDot, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './notifications.css';

/** Pure presentational — every value arrives as a prop, nothing is fetched here. */
export function NotificationInboxView(props: {
  inbox: InboxData | null;
  error: AnswerFailure | null;
  unshown?: readonly string[];
  onAcknowledge?: (notificationId: string) => void;
}) {
  // "No notifications" is the most load-bearing sentence in this app: it is the
  // one that lets Chris stop watching. Printing it before the inbox has
  // answered — or instead of a failure — tells him he is free to look away when
  // we do not know (contract/listAnswer.ts).
  const answer = answerFrom({
    source: props.inbox,
    failure: props.error,
    rowsOf: (inbox: InboxData) => orderInbox(inbox.rows),
  });
  const rows = answer.kind === 'rows' ? answer.rows : [];
  const attentionId = attentionIdOf(rows);
  const settleable = new Set(awaitingAcknowledgement(rows).map((item) => item.id));

  return (
    <ScrollArea className="nv-inbox__scroll">
      <Panel head="Notifications">
        <Stack className="nv-inbox">
          {answer.kind === 'failed' && (
            <InlineError>{`${answer.failure.code}: ${answer.failure.message}`}</InlineError>
          )}
          {answer.kind === 'waiting' && <EmptyState>Reading notifications…</EmptyState>}
          {/* A fact, not reassurance. "All caught up" is the app congratulating
              itself for a state it merely observed. */}
          {answer.kind === 'none' && <EmptyState>No notifications</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-inbox__rows">
              {rows.map((item) => (
                <InboxRow
                  key={item.id}
                  row={item}
                  attention={item.id === attentionId}
                  settleable={settleable.has(item.id)}
                  {...(props.onAcknowledge ? { onAcknowledge: props.onAcknowledge } : {})}
                />
              ))}
            </Stack>
          )}
          {/* What this answer cannot show, in its own numbers. Quiet, and always
              last — an inbox that continues past the edge of the page must not
              read as an inbox that ends there. */}
          {(props.unshown ?? []).map((unshown) => (
            <Text as="p" key={unshown} className="nv-inbox__gap">{unshown}</Text>
          ))}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

function InboxRow(props: {
  row: NotificationView;
  attention: boolean;
  settleable: boolean;
  onAcknowledge?: (notificationId: string) => void;
}) {
  const { row: notification, attention, settleable, onAcknowledge } = props;
  const settled = isSettled(notification);
  const facts = describeRowFacts(notification, attention);
  const className = [
    'nv-inbox__row',
    attention ? 'nv-inbox__row--attention' : '',
    settled ? 'nv-inbox__row--settled' : '',
    settleable ? 'nv-inbox__row--settleable' : '',
  ].filter(Boolean).join(' ');

  return (
    <Stack
      gap={0}
      className={className}
      // The phase is on the row rather than only in the copy, so "is this
      // distinguishable?" is a question a test and a browser can both ask.
      data-phase={notification.phase}
    >
      <ListRow
        label={notification.summary}
        meta={formatRowMeta(notification)}
        // The ONLY ornament on this screen, and only on the single row that is
        // the exception. Everything else stays flat.
        leading={attention ? (
          <PresenceDot
            state="active"
            title={isHumanEscalation(notification)
              ? 'Supervision is asking a human to intervene'
              : 'seen by the provider — not yet settled'}
          />
        ) : undefined}
        // Clickable ONLY where the frozen state machine accepts an ack. A marked
        // escalation that is still `queued` is the most important row here and
        // has nothing to press; offering a button the capability would refuse
        // is worse than offering none.
        {...(settleable && onAcknowledge
          ? { onClick: () => { onAcknowledge(notification.id); } }
          : {})}
      />
      {/* The justification: which rule, which generation of its condition, what
          evidence. All three were missing from the row this screen used to
          render, and each answers a question the summary alone cannot. An
          escalation that is NOT the marked row carries its phase here too —
          quiet, not silent (contract/notificationRead.ts). */}
      <Text as="p" className="nv-inbox__provenance">{facts.provenance}</Text>
      {facts.escalation !== '' && (
        <Text as="p" className="nv-inbox__escalation">{facts.escalation}</Text>
      )}
    </Stack>
  );
}

/**
 * The connected screen.
 *
 * It reads through `agentRuns.supervision` — the frozen door — and draws a host
 * without one as a host without one rather than as an empty inbox. Liveness is
 * kept by re-reading through the same door when the host says something moved:
 * the pushed payload is deliberately ignored, because a second shape of the same
 * Notification arriving by a second path is exactly the drift FZ-VIEW-034 names.
 */
export function NotificationInboxScreen(props: { services: ShellServices }) {
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [unshown, setUnshown] = useState<readonly string[]>([]);
  const [error, setError] = useState<AnswerFailure | null>(null);
  const { services } = props;
  const door = services.agentRuns?.supervision;

  const refresh = useCallback(async (live: () => boolean) => {
    if (door === undefined) return;
    const answer = await door.listNotifications({});
    if (!live()) return;
    if (!answer.ok) {
      setInbox(null);
      setError(answer.error);
      return;
    }
    setInbox({ observedAt: new Date().toISOString(), rows: answer.value.items });
    setUnshown(inboxCompleteness(answer.value));
    setError(null);
  }, [door]);

  useEffect(() => {
    let live = true;
    const alive = () => live;
    if (door === undefined) {
      setError({
        code: 'SupervisionUnavailable',
        message: 'this host has no Supervision engine to read notifications from',
      });
      return () => { live = false; };
    }
    void refresh(alive);
    const unsubscribe = services.subscribe({
      onNotifications: () => { void refresh(alive); },
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [door, refresh, services]);

  const onAcknowledge = useCallback((notificationId: string) => {
    if (door === undefined) return;
    // Optimism would be a lie here: the capability may refuse, and the whole
    // point of the marker is that it tracks durable truth. Re-read instead, and
    // draw a refusal rather than leaving the row looking settled.
    void door.acknowledgeNotification(notificationId).then((answer) => {
      if (!answer.ok) setError(answer.error);
      return refresh(() => true);
    });
  }, [door, refresh]);

  return (
    <NotificationInboxView
      inbox={inbox}
      error={error}
      unshown={unshown}
      onAcknowledge={onAcknowledge}
    />
  );
}
