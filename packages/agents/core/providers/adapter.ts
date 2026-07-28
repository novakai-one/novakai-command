// core/providers — the adapter seam (DEC-C2). One TerminalAdapter interface;
// the real adapter wraps the EXISTING terminal host surface (TerminalManager /
// TerminalHostClient in src/backend/terminal — identical method shapes); the
// mock proves seam replaceability (C §4, AGT-001). No provider-specific code
// outside this directory (red gate C1).
import type { PtyEvent, ProviderName, SpawnOpts, Unsubscribe } from '../../contract/schemas.js';

/** What spawn returns to the agents layer — the mini-contract SpawnResponse. */
export interface SpawnedSession {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  model: string;
}

/**
 * The terminal mini-contract (R3-15): spawn / attach / send / events / close.
 * setSessionModel is OPTIONAL (OD-C3 RULED 2026-07-28): present only when the
 * underlying runtime declares a verified model mechanism (kimi CLI — see
 * spec/pass2-s2/OD-C3-spike.md); absent → typed UnsupportedOperation.
 */
export interface TerminalAdapter {
  spawn(agentId: string, provider: ProviderName, opts: SpawnOpts): Promise<SpawnedSession>;
  attach(sessionId: string): { sessionId: string; state: 'running' | 'exited' } | null;
  send(sessionId: string, input: string): boolean;
  subscribe(sessionId: string, handler: (e: PtyEvent) => void): Unsubscribe;
  close(sessionId: string): boolean;
  /** OD-C3: switch the session's model for real. False = unknown session. */
  setSessionModel?(sessionId: string, model: string): boolean;
  /**
   * B1 DEC-B1-6: rebind a session that outlived this process. The registry has
   * the handle (sessionId + provider conversation id); nothing is live to
   * attach TO — the next send spawns a fresh process carrying the resume id.
   * Present only on adapters whose runtime can adopt a conversation.
   */
  adopt?(input: {
    sessionId: string;
    agentId: string;
    provider: ProviderName;
    providerConversationId: string | null;
    model: string;
    cwd: string;
  }): boolean;
}

/**
 * Structural view of the existing terminal runtime (src/backend/terminal
 * manager.ts TerminalManager and host/client TerminalHostClient share exactly
 * this surface — verified against both). Agents wires to it; it is never
 * rewritten here. The app composition root hands us a live instance.
 */
export interface TerminalRuntimeLike {
  create(options: {
    title?: string;
    cwd: string;
    provider?: string;
    agentId?: string;
    agentToken?: string;
    /**
     * S2a (§22 ruling 5): optional argv/env channels the runtime MAY honor.
     * The kimi CLI's native skills mechanism is `--skills-dir <dir>`
     * (verified via `kimi --help`); providers without a verified native
     * mechanism receive NOVAKAI_SKILLS (colon-joined dirs) as the declared
     * env mechanism. Runtimes that cannot forward them ignore the fields —
     * the gap is recorded in NOTES.md, not hidden.
     */
    argv?: string[];
    env?: Record<string, string>;
    /**
     * OD-C3 RULED (spike 2026-07-28, spec/pass2-s2/OD-C3-spike.md): the model
     * to start the session on. Runtimes with a model mechanism (kimi CLI:
     * `-m <alias>`) honor it; others ignore it (the at-spawn override then
     * lives only in the agents record — gap recorded, never hidden).
     */
    model?: string;
  }): Promise<{ agentId: string; status: 'running' | 'exited'; terminalPid?: number }>;
  write(agentId: string, data: string): boolean;
  kill(agentId: string): boolean;
  list(): Array<{ agentId: string; status: 'running' | 'exited' }>;
  onData(callback: (agentId: string, data: string) => void): void;
  onExit(callback: (agentId: string, exitCode: number | null) => void): void;
  /**
   * OD-C3 RULED: OPTIONAL mid-session model-switch channel. Present only on
   * runtimes with a verified mechanism (kimi CLI: `-S <id> -m <alias>`, sticky
   * per session — see the spike report). Absent = the provider cannot switch;
   * the agents contract surfaces typed UnsupportedOperation.
   */
  setModel?(agentId: string, model: string): boolean;
}
