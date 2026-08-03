// shell/ui/screens/supervision/NotificationInboxScreen.tsx — Lane C's Shell
// surface: the notification inbox. Kit-composed ONLY (red gate 3).
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
//     look, because a surface that has to say "this needs you" has already
//     failed at being one.
//   - Settled rows stay visible and stop competing — dimmed, in place, so the
//     inbox reads as a record rather than a queue that eats its own history.
//
// The shell holds no notification truth: rows arrive from Supervision and are
// shown as measured. The only action offered is the one the frozen state machine
// actually accepts — an acknowledgement of a Notification the provider has been
// observed to receive.
import React, { useCallback, useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import {
  attentionIdOf, formatRowMeta, isSettled, orderInbox,
  type NotificationInboxView as InboxData, type NotificationRowView,
} from '../../../contract/notifications.js';
import {
  EmptyState, ListRow, Panel, PresenceDot, ScrollArea, Stack,
} from '../../kit/index.js';
import './notifications.css';

/** Pure presentational — every value arrives as a prop, nothing is derived here. */
export function NotificationInboxView(props: {
  inbox: InboxData | null;
  onAcknowledge?: (notificationId: string) => void;
}) {
  const rows = orderInbox(props.inbox?.rows ?? []);
  const attentionId = attentionIdOf(rows);

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Panel head="Notifications">
        <Stack className="nv-inbox">
          {rows.length === 0 ? (
            // A fact, not reassurance. "All caught up" is the app congratulating
            // itself for a state it merely observed.
            <EmptyState>No notifications</EmptyState>
          ) : (
            <Stack gap={0} className="nv-inbox__rows">
              {rows.map((row) => (
                <InboxRow
                  key={row.id}
                  row={row}
                  attention={row.id === attentionId}
                  {...(props.onAcknowledge ? { onAcknowledge: props.onAcknowledge } : {})}
                />
              ))}
            </Stack>
          )}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

function InboxRow(props: {
  row: NotificationRowView;
  attention: boolean;
  onAcknowledge?: (notificationId: string) => void;
}) {
  const { row, attention, onAcknowledge } = props;
  const settled = isSettled(row);
  const className = [
    'nv-inbox__row',
    attention ? 'nv-inbox__row--attention' : '',
    settled ? 'nv-inbox__row--settled' : '',
  ].filter(Boolean).join(' ');

  return (
    <Stack gap={0} className={className}>
      <ListRow
        label={row.summary}
        meta={formatRowMeta(row)}
        // The ONLY ornament on this screen, and only on the single row that is
        // the exception. Everything else stays flat.
        leading={attention ? (
          <PresenceDot state="active" title="seen by the provider — not yet settled" />
        ) : undefined}
        {...(attention && onAcknowledge
          ? { onClick: () => { onAcknowledge(row.id); } }
          : {})}
      />
    </Stack>
  );
}

export function NotificationInboxScreen(props: { services: ShellServices }) {
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const { services } = props;

  const refresh = useCallback(async () => {
    const next = await services.getNotificationInbox?.();
    if (next) setInbox(next);
  }, [services]);

  useEffect(() => {
    let live = true;
    // One immediate pull so the screen is never blank waiting for an event,
    // then the subscription keeps it current.
    void services.getNotificationInbox?.().then((next) => { if (live) setInbox(next); });
    const off = services.subscribe({
      onNotifications: (next) => { if (live) setInbox(next); },
    });
    return () => { live = false; off(); };
  }, [services]);

  const onAcknowledge = useCallback((notificationId: string) => {
    // Optimism would be a lie here: the capability may refuse, and the whole
    // point of the marker is that it tracks durable truth. Re-read instead.
    void services.acknowledgeNotification?.(notificationId).then(() => refresh());
  }, [services, refresh]);

  if (!services.getNotificationInbox) {
    return <EmptyState>Supervision is not available in this host.</EmptyState>;
  }
  return <NotificationInboxView inbox={inbox} onAcknowledge={onAcknowledge} />;
}
