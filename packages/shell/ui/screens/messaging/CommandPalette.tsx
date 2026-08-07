// shell/ui/screens/messaging/CommandPalette.tsx — ⌘K over conversations (SHL-004).
// Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs enforces).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationSummary } from '../../../contract/index.js';
import { MenuRow, Stack, Text, TextInput } from '../../kit/index.js';

export function CommandPalette(props: {
  open: boolean;
  conversations: ConversationSummary[];
  onSelect(id: string): void;
  onClose(): void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [props.open]);

  const matches = useMemo(() => {
    const needle = q.toLowerCase();
    return props.conversations.filter((c) => !c.archived && c.title.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, props.conversations]);

  useEffect(() => {
    if (!props.open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(matches.length - 1, s + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      if (e.key === 'Enter') { const c = matches[sel]; if (c) { props.onSelect(c.id); props.onClose(); } }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [props.open, matches, sel, props]);

  if (!props.open) return null;
  return (
    <Stack className="nv-palette nv-palette--center" role="dialog" aria-label="Jump to a chat">
      <Stack className="nv-palette__input">
        <TextInput ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a chat…" />
      </Stack>
      {matches.map((c, i) => (
        <MenuRow
          key={c.id}
          className="nv-palette__row"
          label={<Text className="nv-palette__desc" style={{ color: 'var(--ink)' }}>{c.title}</Text>}
          trailing={<Text className="nv-palette__src">{c.kind}</Text>}
          selected={i === sel}
          onHover={() => setSel(i)}
          onPick={() => { props.onSelect(c.id); props.onClose(); }}
        />
      ))}
      {matches.length === 0 && <Text className="nv-palette__row" style={{ cursor: 'default', padding: '6px 10px' }}>No matches.</Text>}
    </Stack>
  );
}
