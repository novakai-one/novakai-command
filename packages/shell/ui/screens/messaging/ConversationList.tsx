// shell/ui/screens/messaging/ConversationList.tsx — SHL-004.
// Grouped Pinned / Agents / Rooms / Archive; + new chat always visible.
import React from 'react';
import type { ConversationSummary, PresenceSnapshot } from '../../../contract/index.js';
import { Button, ListRow, PresenceDot, Badge, EmptyState } from '../../kit/index.js';

const GROUPS = [
  { key: 'pinned', label: 'Pinned' },
  { key: 'agents', label: 'Agents' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'archive', label: 'Archive' },
] as const;

type GroupKey = (typeof GROUPS)[number]['key'];

function groupOf(c: ConversationSummary): GroupKey {
  if (c.archived) return 'archive';
  if (c.pinned) return 'pinned';
  return c.kind === 'room' ? 'rooms' : 'agents';
}

export function ConversationList(props: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  presenceOf(agentId: string | undefined): PresenceSnapshot;
  onSelect(id: string): void;
  onNew(): void;
  onSpawnMock?(): void;
  onSpawnReal?(): void;
}) {
  const byGroup = new Map<GroupKey, ConversationSummary[]>();
  for (const c of props.conversations) {
    const g = groupOf(c);
    byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
  }
  return (
    <div className="nv-convo" role="navigation" aria-label="Conversations">
      <div style={{ padding: '4px 10px' }}>
        <Button primary style={{ width: '100%' }} onClick={props.onNew}>
          New chat&nbsp;&nbsp;⌘N
        </Button>
        {props.onSpawnMock && (
          <Button style={{ width: '100%', marginTop: 6 }} onClick={props.onSpawnMock}>
            ⚡ Spawn mock agent
          </Button>
        )}
        {props.onSpawnReal && (
          <Button style={{ width: '100%', marginTop: 6 }} onClick={props.onSpawnReal}>
            🌙 Spawn real Kimi
          </Button>
        )}
      </div>
      {props.conversations.length === 0 && (
        <EmptyState>No chats yet — start one above.</EmptyState>
      )}
      {GROUPS.map(({ key, label }) => {
        const items = byGroup.get(key);
        if (!items || items.length === 0) return null;
        return (
          <div key={key}>
            <div className="nv-convo__group">{label}</div>
            {items.map((c) => {
              const p = c.agentId ? props.presenceOf(c.agentId) : null;
              return (
                <ListRow
                  key={c.id}
                  label={c.title}
                  selected={c.id === props.selectedId}
                  onClick={() => props.onSelect(c.id)}
                  leading={p ? <PresenceDot state={p.state} live={false} /> : undefined}
                  meta={c.unreadCount > 0 ? <Badge>{c.unreadCount}</Badge> : undefined}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
