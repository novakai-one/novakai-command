// shell/contract/services.ts — the UI's data seam. Screens render ONLY
// contract data through this interface (B §12); implementations: the node
// bridge (real packages/messaging + foundation) or an in-memory mock (tests).
import type { AgentEvent, LayoutRecord, PresenceSource, SettingsRecord } from './types.js';
import type { SetSettingError } from './settings.js';
import type { PersistFailedError } from './errors.js';

/**
 * S2a: shell-side view of an agent definition v2 (plain data — the browser
 * never imports packages/agents; the bridge maps contract objects to these).
 */
export interface AgentDefView {
  id: string;
  displayName: string;
  provider: 'kimi' | 'claude' | 'codex' | 'mock';
  model: string;
  instructions: string;
  hooks: Array<{ id: string; event: string; action: { kind: string; text?: string; message?: string } }>;
  skills: string[]; // skill id refs
  status: 'defined' | 'archived';
  version: number; // CAS version for updateAgent
}

export interface SkillView {
  id: string;
  name: string;
  path: string;
  description: string;
}

export type AgentOpError = { code: string; message: string };

export interface ShellAgentsServices {
  listAgents(): Promise<AgentDefView[]>;
  defineAgent(input: {
    displayName: string; provider: AgentDefView['provider']; model: string;
    instructions?: string; skills?: string[];
  }, clientOpId: string): Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  updateAgent(id: string, patch: Partial<Pick<AgentDefView, 'displayName' | 'provider' | 'instructions' | 'skills'>>,
    expectedVersion: number, clientOpId: string):
    Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  /** AGT-003/DEC-S2-5: def-level model writes go through agents.setModel ONLY. */
  setModel(agentId: string, model: string, clientOpId: string):
    Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  listSkills(): Promise<SkillView[]>;
}

/** Mint a clientOpId at the interaction layer (M5/DEC-S2-12). Browser + node safe. */
export const mintShellOpId = (): string => `op_${globalThis.crypto.randomUUID()}`;

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
  // M4: write/materialise failures are typed PersistFailed Results, never rejections.
  // M5/DEC-S2-12: clientOpId REQUIRED on every UI-originated mutation.
  getLayout(): Promise<{ ok: true; value: { record: LayoutRecord; version: number } } | { ok: false; error: PersistFailedError }>;
  setLayout(patch: Partial<LayoutRecord>, clientOpId: string): Promise<{ ok: true; value: { record: LayoutRecord; version: number } } | { ok: false; error: PersistFailedError }>;
  getSettings(): Promise<SettingsRecord[]>;
  setSetting(key: string, value: unknown, opts: { derivedFrom?: string; theme?: 'dark' | 'light'; clientOpId: string }):
    Promise<{ ok: true; value: SettingsRecord } | { ok: false; error: SetSettingError }>;

  // agents (S2a: agent-def UI + model picker; shell keeps NO model truth —
  // every write goes through the agents contract via this seam)
  agents?: ShellAgentsServices;

  // presence (agents-lite seam; the demo bridge wires the REAL packages/agents
  // agentEvent stream; tests/mock inject an in-memory source)
  presence: PresenceSource;

  // Demo affordance (SHL-006/007 end-to-end proof): define + spawn a mock
  // agent session so presence dot / typing bubble / activity line move live.
  // Optional: only demo backends implement it.
  spawnMockAgent?(title?: string): Promise<{ ok: true; conversation: ConversationSummary } | { ok: false; error: string }>;
  // Demo affordance: spawn a REAL kimi-CLI-backed agent (present only when
  // the demo bridge reports the CLI is installed). Replies stream through the
  // agents live-lane into the thread.
  spawnRealKimiAgent?(title?: string): Promise<{ ok: true; conversation: ConversationSummary } | { ok: false; error: string }>;
}
