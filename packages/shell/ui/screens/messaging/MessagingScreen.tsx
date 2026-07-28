// shell/ui/screens/messaging/MessagingScreen.tsx — the messaging workspace:
// conversation list data flow, thread, composer wiring, ⌘N / ⌘K chords,
// render-speed setting per conversation (SHL-004…007).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChatMessage, ConversationSummary, PresenceSnapshot, ShellServices,
} from '../../../contract/index.js';
import { PresenceTracker, SlashRegistry, renderSpeedKey, DEFAULT_RENDER_SPEED, settingValue, mintShellOpId, subscribeFocus, getFocus, registerActionHandler, type ScreenContext, type ChatMessage as ChatMessageT } from '../../../contract/index.js';
import { ConversationList } from './ConversationList.js';
import { ThreadView } from './ThreadView.js';
import { Composer } from './Composer.js';
import { CommandPalette } from './CommandPalette.js';
import { FocusChip } from './FocusChip.js';
import { appendDedup, dedupeById } from './messageList.js';
import { Stack } from '../../kit/index.js';
import { registerInspectorScreen } from '../../inspector/registry.js';
import { MessageInspector } from '../../inspector/MessageInspector.js';
import './messaging.css';

export function MessagingScreen(props: {
  services: ShellServices;
  composerHeight: number;
  onComposerResize(deltaPx: number): void;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onInspectConversation(c: ConversationSummary): void;
  onInspectMessage(m: ChatMessageT): void;
  onOpenSettings(): void;
  registry: SlashRegistry;
  tracker: PresenceTracker;
  settings: import('../../../contract/types.js').SettingsRecord[];
  refreshSettings(): Promise<void>;
}) {
  const { services } = props;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, setPresenceTick] = useState(0);
  const [focus, setFocus] = useState<ScreenContext>(getFocus());

  useEffect(() => subscribeFocus(setFocus), []);

  useEffect(() => { void services.listConversations().then(setConversations); }, [services]);
  useEffect(() => props.tracker.subscribe(() => setPresenceTick((n) => n + 1)), [props.tracker]);

  // S2b inspector (DEC-S2-8): the message kind's screen + its primary action.
  // "Inspect and act": reply selects the conversation and focuses the composer.
  useEffect(() => {
    registerInspectorScreen('message', MessageInspector);
    registerActionHandler('message', 'reply', async (ref) => {
      const el = document.querySelector<HTMLTextAreaElement>('.composer-wrap textarea');
      el?.focus();
      return { focused: true, ref };
    });
  }, []);

  const selected = conversations.find((c) => c.id === props.selectedId) ?? null;

  useEffect(() => {
    if (!props.selectedId) { setMessages([]); return; }
    void services.getMessages(props.selectedId).then(setMessages);
  }, [services, props.selectedId]);

  useEffect(() => services.subscribe({
    onMessage: (m) => {
      // G1: the broadcast may duplicate the optimistic echo's real id — never
      // append a message id that's already in the thread.
      if (m.conversationId === props.selectedId) setMessages((cur) => appendDedup(cur, m));
    },
    onConversation: () => { void services.listConversations().then(setConversations); },
  }), [services, props.selectedId]);

  // ⌘N new chat · ⌘K palette (SHL-004)
  const newChat = useCallback(async () => {
    const c = await services.createConversation('New chat', 'agent', mintShellOpId());
    setConversations((cur) => [c, ...cur]);
    props.onSelect(c.id);
  }, [services, props]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void newChat(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [newChat]);

  const speed = useMemo(() => {
    if (!selected) return DEFAULT_RENDER_SPEED;
    return settingValue<number>(props.settings, renderSpeedKey(selected.id))
      ?? settingValue<number>(props.settings, 'renderSpeed.default')
      ?? DEFAULT_RENDER_SPEED;
  }, [props.settings, selected]);

  const presenceOf = useCallback((agentId?: string): PresenceSnapshot =>
    agentId ? props.tracker.get(agentId) : { agentId: '', state: 'offline' }, [props.tracker]);

  const send = async (text: string) => {
    if (!selected) return;
    const optimistic: ChatMessage = {
      id: `pending_${Date.now()}`,
      conversationId: selected.id,
      senderId: 'me',
      text,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((cur) => [...cur, optimistic]); // pending drawn immediately (red gate 5)
    const res = await services.sendMessage(selected.id, text);
    // G1: if the broadcast beat the RPC resolve, the real id is already in the
    // list — replacing the pending bubble would duplicate it. Dedup by id.
    setMessages((cur) => dedupeById(cur.map((m) => m.id === optimistic.id
      ? (res.ok ? { ...res.message, pending: false } : { ...m, pending: false, failed: res.error })
      : m)));
  };

  const onBuiltin = async (name: string, args: string) => {
    switch (name) {
      case 'new': await newChat(); break;
      case 'pin':
        if (selected) {
          // F1/DEC-S2-12: clientOpId minted at the interaction layer, persisted
          // as a conversationView record (survives restart).
          await services.pinConversation(selected.id, !selected.pinned, mintShellOpId());
          setConversations(await services.listConversations());
        }
        break;
      case 'archive':
        if (selected) {
          await services.archiveConversation(selected.id, !selected.archived, mintShellOpId());
          setConversations(await services.listConversations());
        }
        break;
      case 'speed': {
        if (selected) {
          const n = Number(args);
          if (Number.isFinite(n)) {
            await services.setSetting(renderSpeedKey(selected.id), n, { clientOpId: mintShellOpId() });
            await props.refreshSettings();
          }
        }
        break;
      }
      case 'theme':
        if (args === 'dark' || args === 'light') {
          await services.setSetting('theme', args, { clientOpId: mintShellOpId() });
          await props.refreshSettings();
        }
        break;
    }
  };

  const onProvider = (name: string, args: string) => {
    // Structured contract message forwarded to the provider adapter (R3-13) —
    // never shell-side stdin injection. Until agents lands, a typed note.
    void name; void args;
  };

  return (
    <>
      <ThreadView
        conversation={selected}
        messages={messages}
        presence={selected?.agentId ? props.tracker.get(selected.agentId) : null}
        focused={true}
        selfId="me"
        onInspectMessage={(m) => props.onInspectMessage(m)}
      />
      <Stack horizontal className="nv-composer-row">
        <FocusChip focus={focus} />
      </Stack>
      <Composer
        registry={props.registry}
        height={props.composerHeight}
        onResize={props.onComposerResize}
        onSend={(t) => void send(t)}
        onBuiltin={(n, a) => void onBuiltin(n, a)}
        onProvider={onProvider}
      />
      <CommandPalette
        open={paletteOpen}
        conversations={conversations}
        onSelect={(id) => props.onSelect(id)}
        onClose={() => setPaletteOpen(false)}
      />
    </>
  );
}

export function MessagingRail(props: {
  services: ShellServices;
  tracker: PresenceTracker;
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  useEffect(() => { void props.services.listConversations().then(setConversations); }, [props.services]);
  useEffect(() => props.services.subscribe({
    onConversation: () => { void props.services.listConversations().then(setConversations); },
  }), [props.services]);
  return (
    <ConversationList
      conversations={conversations}
      selectedId={props.selectedId}
      presenceOf={(id) => (id ? props.tracker.get(id) : { agentId: '', state: 'offline' })}
      onSelect={props.onSelect}
      onNew={() => {
        void props.services.createConversation('New chat', 'agent', mintShellOpId()).then((c) => {
          setConversations((cur) => [c, ...cur]);
          props.onSelect(c.id);
        });
      }}
      onSpawnMock={props.services.spawnMockAgent ? () => {
        void props.services.spawnMockAgent!().then((r) => {
          void props.services.listConversations().then(setConversations);
          if (r.ok) props.onSelect(r.conversation.id);
        });
      } : undefined}
      onSpawnReal={props.services.spawnRealKimiAgent ? () => {
        void props.services.spawnRealKimiAgent!().then((r) => {
          void props.services.listConversations().then(setConversations);
          if (r.ok) props.onSelect(r.conversation.id);
        });
      } : undefined}
    />
  );
}
