// Shared data shapes for the browser-session subsystem. Pure types only.

/** A live headless Chrome process bound to one session. */
export interface BrowserInstance {
  processId: number;
  port: number;
  userDataDir: string;
  /** CDP base URL, e.g. http://127.0.0.1:9300 */
  cdpEndpoint: string;
}

export type SessionStatus = 'active' | 'released';

/** The persisted record of one agent's browser session. */
export interface Session {
  sessionId: string;
  agentId: string;
  instance: BrowserInstance;
  status: SessionStatus;
  /** ISO instant after which an unused session may be reclaimed. */
  leaseExpiresAt: string;
  /** Last URL the session navigated to, if any. */
  lastUrl?: string;
}

/** What a caller receives from the broker — enough to drive and to watch. */
export interface SessionHandle {
  sessionId: string;
  cdpEndpoint: string;
  pageUrl: string | null;
}

/** Instructions for launching a browser instance. */
export interface LaunchSpec {
  headless: boolean;
}

export type CommandKind = 'goto' | 'click' | 'type' | 'press' | 'text' | 'eval' | 'shot';

/** One imperative action against a session's current page. */
export interface BrowserCommand {
  kind: CommandKind;
  href?: string;
  selector?: string;
  text?: string;
  script?: string;
  shotPath?: string;
}

/** Result of applying a BrowserCommand. */
export interface ActionResult {
  success: boolean;
  pageUrl: string;
  title?: string;
  text?: string;
  shotPath?: string;
  error?: string;
}

export type AllocationKind = 'reuse' | 'launch';

/** The pure decision of whether to reuse an existing session or launch fresh. */
export interface Allocation {
  kind: AllocationKind;
  session?: Session;
}
