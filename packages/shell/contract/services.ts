// shell/contract/services.ts — the UI's data seam. Screens render ONLY
// contract data through this interface (B §12); implementations: the node
// bridge (real packages/messaging + foundation) or an in-memory mock (tests).
import type { AgentEvent, LayoutRecord, PresenceSource, SettingsRecord } from './types.js';
import type { SetSettingError } from './settings.js';

export interface ConversationSummary {
  id: string;             // ConversationId — shell-side conversation identity
  threadId: string;       // messaging ThreadId backing it
  title: string;
  kind: 'agent' | 'room' | 'direct';
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  unreadCount: number;
  agentId?: string;       // when kind === 'agent' — drives the presence dot
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: string;
  pending?: boolean;
  failed?: string;        // typed inline error message (never blank — red gate 5)
}

export interface MessagingEvents {
  onMessage?(m: ChatMessage): void;
  onConversation?(c: ConversationSummary): void;
}

export interface ShellServices {
  // conversations (messaging owns CRUD — §11 ruling 9; shell calls its contract)
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(title: string, kind: ConversationSummary['kind']): Promise<ConversationSummary>;
  pinConversation(id: string, pinned: boolean): Promise<void>;
  archiveConversation(id: string, archived: boolean): Promise<void>;

  // messages
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  sendMessage(conversationId: string, text: string): Promise<{ ok: true; message: ChatMessage } | { ok: false; error: string }>;
  subscribe(events: MessagingEvents): () => void;

  // layout + settings (shell-owned kinds)
  getLayout(): Promise<{ record: LayoutRecord; version: number }>;
  setLayout(patch: Partial<LayoutRecord>): Promise<{ record: LayoutRecord; version: number }>;
  getSettings(): Promise<SettingsRecord[]>;
  setSetting(key: string, value: unknown, opts?: { derivedFrom?: string; theme?: 'dark' | 'light' }):
    Promise<{ ok: true; value: SettingsRecord } | { ok: false; error: SetSettingError }>;

  // presence (agents-lite seam; the demo bridge wires the REAL packages/agents
  // agentEvent stream; tests/mock inject an in-memory source)
  presence: PresenceSource;

  // Demo affordance (SHL-006/007 end-to-end proof): define + spawn a mock
  // agent session so presence dot / typing bubble / activity line move live.
  // Optional: only demo backends implement it.
  spawnMockAgent?(title?: string): Promise<{ ok: true; conversation: ConversationSummary } | { ok: false; error: string }>;
}
