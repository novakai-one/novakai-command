// shell/ui/screens/messaging/MessagingScreen.tsx — the kit-legal mount and
// nothing else: read the chosen design from settings, resolve it through the
// registry (unknown ids fall back to The Bench — M1-06), feed it the ONE
// projection + command set, keep ⌘N and send-time focus working host-side.
import React, { useCallback, useEffect, useMemo } from 'react';
import type { ShellServices, SlashRegistry, PresenceTracker, SettingsRecord } from '../../../contract/index.js';
import { mintShellOpId, settingValue } from '../../../contract/index.js';
import { resolveMessagesDesign } from '../../messages-designs/registry';
import { createBenchCommands } from './benchCommands.js';
import { useBenchData } from './useBenchData.js';
import { DesignPicker } from './DesignPicker.js';
import { Stack } from '../../kit/index.js';

export const MESSAGES_DESIGN_SETTING = 'messagesDesign';

export function MessagingScreen(props: {
  services: ShellServices;
  registry: SlashRegistry;
  tracker: PresenceTracker;
  settings: SettingsRecord[];
  refreshSettings(): Promise<void>;
  selectedId: string | null;
  onSelect(id: string | null): void;
}) {
  const { services, registry, tracker, selectedId, onSelect } = props;
  const api = useBenchData({ services, tracker, selectedId });
  const commands = useMemo(
    () => createBenchCommands({ services, api, registry, onSelect }),
    [services, api, registry, onSelect],
  );

  // ⌘N new chat — kept feature; the design's own keys (⌘K, F, [, ]) stay its own.
  const newChat = useCallback(async () => {
    const c = await services.createConversation('New chat', 'agent', mintShellOpId());
    await api.refreshConversations();
    onSelect(c.id);
  }, [services, api, onSelect]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void newChat(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [newChat]);

  // S3 (M3-01): the read cursor advances only while a conversation is SELECTED
  // — its transcript is in front of Chris and auto-follows new messages.
  // Opening the app or the room advances nothing; the server persists the
  // cursor and rebroadcasts, so the derived badges settle everywhere.
  const latest = selectedId ? api.lastMessageId(selectedId) : undefined;
  useEffect(() => {
    if (!selectedId || !latest || !services.markConversationRead) return;
    const convo = api.conversations.find((c) => c.id === selectedId);
    if (!convo || convo.lastReadMessageId === latest) return;
    void services.markConversationRead(selectedId, latest, mintShellOpId());
  }, [selectedId, latest, services, api.conversations]);

  const design = resolveMessagesDesign(settingValue<string>(props.settings, MESSAGES_DESIGN_SETTING));

  return (
    <Stack className="nv-messages-mount" style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      {api.ready && <design.View data={api.data} commands={commands} />}
      <DesignPicker
        services={services}
        current={design.id}
        refreshSettings={props.refreshSettings}
      />
    </Stack>
  );
}
