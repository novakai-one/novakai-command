// SessionBroker — the application core. Get-or-create one isolated browser per
// session id, persisted as one JSON file per session so concurrent CLI processes
// never clobber each other's registry. Contention is eliminated by partition
// (one session ⇢ one instance), not by locking a shared tab. Impure work
// (spawning Chrome) lives behind the injected BrowserProvider port.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decideAllocation, isLeaseExpired, leaseExpiresAt } from './domain/rules.js';
import type { BrowserInstance, LaunchSpec, Session, SessionHandle } from './domain/types.js';

/** Port the broker depends on for the impure browser lifecycle. */
export interface BrowserProvider {
  launch(spec: LaunchSpec): Promise<BrowserInstance>;
  dispose(instance: BrowserInstance): Promise<void>;
}

export interface BrokerDeps {
  provider: BrowserProvider;
  /** Directory holding one JSON file per session. */
  registryDir: string;
  clock?: () => Date;
  ttlMs?: number;
  isAlive?: (processId: number) => boolean;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function defaultIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export class SessionBroker {
  private readonly provider: BrowserProvider;
  private readonly registryDir: string;
  private readonly clock: () => Date;
  private readonly ttlMs: number;
  private readonly isAlive: (processId: number) => boolean;
  private sessions = new Map<string, Session>();

  constructor(deps: BrokerDeps) {
    this.provider = deps.provider;
    this.registryDir = deps.registryDir;
    this.clock = deps.clock ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.load();
  }

  /** Get the agent's session, creating (or replacing a stale) one as needed.
   *  `spec` only applies when a fresh instance is launched; a reused session
   *  keeps whatever it was launched with. */
  async acquire(sessionId: string, agentId: string, spec: LaunchSpec = { headless: true }): Promise<SessionHandle> {
    await this.sweep();
    const existing = this.sessions.get(sessionId);
    const alive = existing ? this.isAlive(existing.instance.processId) : false;
    const decision = decideAllocation(existing, alive, this.clock());
    if (decision.kind === 'reuse' && decision.session) {
      return this.renew(decision.session);
    }
    if (existing) await this.provider.dispose(existing.instance);
    return this.create(sessionId, agentId, spec);
  }

  private renew(session: Session): SessionHandle {
    const renewed: Session = { ...session, leaseExpiresAt: leaseExpiresAt(this.clock(), this.ttlMs) };
    this.sessions.set(renewed.sessionId, renewed);
    this.persist(renewed);
    return this.toHandle(renewed);
  }

  private async create(sessionId: string, agentId: string, spec: LaunchSpec): Promise<SessionHandle> {
    const instance = await this.provider.launch(spec);
    const session: Session = {
      sessionId,
      agentId,
      instance,
      status: 'active',
      leaseExpiresAt: leaseExpiresAt(this.clock(), this.ttlMs),
    };
    this.sessions.set(sessionId, session);
    this.persist(session);
    return this.toHandle(session);
  }

  /** Explicitly tear down a session and free its instance. */
  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.provider.dispose(session.instance);
    this.sessions.delete(sessionId);
    this.forget(sessionId);
  }

  /** Reclaim every expired or dead session's instance. */
  async sweep(): Promise<void> {
    const instant = this.clock();
    for (const [identifier, session] of this.sessions) {
      if (isLeaseExpired(session, instant) || !this.isAlive(session.instance.processId)) {
        await this.provider.dispose(session.instance);
        this.sessions.delete(identifier);
        this.forget(identifier);
      }
    }
  }

  /** Live roster — the seam a future mirror viewer consumes. */
  list(): SessionHandle[] {
    return [...this.sessions.values()].map((session) => this.toHandle(session));
  }

  /** Record the last URL a session navigated to (keeps handles useful). */
  record(sessionId: string, pageUrl: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastUrl = pageUrl;
    this.persist(session);
  }

  private toHandle(session: Session): SessionHandle {
    return { sessionId: session.sessionId, cdpEndpoint: session.instance.cdpEndpoint, pageUrl: session.lastUrl ?? null };
  }

  private sessionFile(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.registryDir, `${safe}.json`);
  }

  private load(): void {
    if (!existsSync(this.registryDir)) return;
    for (const file of readdirSync(this.registryDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const session = JSON.parse(readFileSync(path.join(this.registryDir, file), 'utf8')) as Session;
        this.sessions.set(session.sessionId, session);
      } catch {
        // skip a corrupt entry rather than fail the whole load
      }
    }
  }

  private persist(session: Session): void {
    mkdirSync(this.registryDir, { recursive: true });
    writeFileSync(this.sessionFile(session.sessionId), JSON.stringify(session, null, 2));
  }

  private forget(sessionId: string): void {
    rmSync(this.sessionFile(sessionId), { force: true });
  }
}
