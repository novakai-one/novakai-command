// shell/contract/services.ts — the UI's data seam. Screens render ONLY
// contract data through this interface (B §12); implementations: the node
// bridge (real packages/messaging + foundation) or an in-memory mock (tests).
import type { AgentEvent, LayoutRecord, PresenceSource, SettingsRecord } from './types.js';
import type { SetSettingError } from './settings.js';
import type { PersistFailedError } from './errors.js';
import type { ScreenContext } from './context.js';
import type { RunUsageTableView, UsageTableView } from './usage.js';
import type { WatcherListView } from './watchers.js';
import type { NotificationInboxView } from './notifications.js';

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
  /** Stable idempotency key; resend reuses it instead of minting a new post. */
  clientOpId?: string;
  /** S2b (SHL-008): send-time screen context snapshot — present on every
   * human-composed message (red gate 2; {app, ref:'none'} counts). */
  context?: ScreenContext;
}

export interface MessagingEvents {
  onMessage?(m: ChatMessage): void;
  onConversation?(c: ConversationSummary): void;
  /**
   * B1b §8: the supervision usage table, broadcast by the server every
   * supervision.usageIntervalSec (DEC-B1-11). Hosts without supervision simply
   * never call it.
   */
  onUsage?(table: UsageTableView): void;
  /**
   * B3d lane C: the supervision notification inbox. Pushed whenever a
   * Notification's durable state moves, so the ONE row that is the exception
   * follows the capability rather than a poll interval.
   */
  onNotifications?(inbox: NotificationInboxView): void;
  /** A committed Agents evidence event says the rebuildable Run rows may have moved. */
  onRunUsageChanged?(): void;
}

export interface ShellServices {
  // conversations (messaging owns CRUD — §11 ruling 9; shell calls its contract)
  listConversations(): Promise<ConversationSummary[]>;
  // F1/DEC-S2-12: creation is a UI-originated mutation — clientOpId REQUIRED.
  createConversation(title: string, kind: ConversationSummary['kind'], clientOpId: string): Promise<ConversationSummary>;
  // F1/DEC-S2-11: pin/archive persist as shell-owned conversationView records;
  // clientOpId REQUIRED (R3-10 — minted at the interaction layer).
  pinConversation(id: string, pinned: boolean, clientOpId: string): Promise<void>;
  archiveConversation(id: string, archived: boolean, clientOpId: string): Promise<void>;

  // messages
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  sendMessage(conversationId: string, text: string, clientOpId: string): Promise<
    { ok: true; message: ChatMessage }
    | { ok: false; error: string | { code: string; message?: string; [key: string]: unknown } }
  >;
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

  // S2b context bus (SHL-008): the UI publishes every focus change; the shell
  // host (demo bridge / future Electron) is the focus authority and attaches
  // the send-time snapshot to each human-composed message. Fire-and-forget.
  publishFocus?(focus: ScreenContext): void;

  // Demo affordance (SHL-006/007 end-to-end proof): define + spawn a mock
  // agent session so presence dot / typing bubble / activity line move live.
  // Optional: only demo backends implement it.
  spawnMockAgent?(title?: string): Promise<{ ok: true; conversation: ConversationSummary } | { ok: false; error: string }>;
  // Demo affordance: spawn a REAL kimi-CLI-backed agent (present only when
  // the demo bridge reports the CLI is installed). Replies stream through the
  // agents live-lane into the thread.
  spawnRealKimiAgent?(title?: string): Promise<{ ok: true; conversation: ConversationSummary } | { ok: false; error: string }>;

  /**
   * B1b §8 supervision surface (DEC-B1-11): the current usage table, pulled
   * once so the screen is never blank while it waits for the next broadcast.
   * Absent on hosts with no supervision engine — the screen draws that.
   */
  getUsageTable?(): Promise<UsageTableView>;

  /** Current watcher rules joined to their generation-fenced deadlines. */
  listWatchers?(): Promise<WatcherListView>;
  /**
   * B3d lane C supervision surface: the current notification inbox, pulled once
   * so the screen is never blank while it waits for the next push. Absent on
   * hosts with no supervision engine — the screen draws that.
   */
  getNotificationInbox?(): Promise<NotificationInboxView>;
  /**
   * Settle one Notification. The ONLY mutation this surface offers, because the
   * frozen state machine accepts an acknowledgement from `transcript-observed`
   * and from nothing else. Resolves when the durable state has moved.
   */
  acknowledgeNotification?(notificationId: string): Promise<void>;
  /** B3d Run usage read from Runtime views; older hosts omit or refuse it. */
  getRunUsageTable?(): Promise<RunUsageTableView>;
}
