// The object model — the ONE write interface for the durable mission graph
// (plan v2 §1.2, ruling S5). Domain intent in, validated typed blocks out:
// callers never construct raw JSON lines, never know store filenames, never
// touch the engine directly. Roots are injected once at composition
// (server/index.ts); the engine underneath (src/backend/stores/) enforces the
// schema law, locking, CAS, and atomic-write discipline.
//
// Domain mapping (ruling M13): the durable Agent is the stable AI teammate
// identity (≈ CONTEXT.md Person); a terminal session is its Presence. The
// Agent block's `sessionId` points at the CURRENT Presence; prior values
// rotate into the `sessions` history array — an overwrite never erases
// Presence history.
import { randomUUID } from 'node:crypto';
import {
  appendLine, ensureStoreFiles, replaceLine, readStoreDir,
  StoreConflictError, StoreRefusalError, StoreValidationError,
} from '../stores/store.mjs';

export interface ObjectModelRoots {
  storesDir: string;
  /** Optional gate-baseline inventory; new ids enroll only when supplied. */
  baselinePath?: string;
}

export interface AgentBlock {
  id: string;
  kind: 'agent';
  ts: string;
  name: string;
  provider: string;
  status: 'spawning' | 'live' | 'failed' | 'retired';
  sessionId?: string;
  sessions?: string[];
  refs: Array<{ kind: string; value: string }>;
  updated?: string;
  [key: string]: unknown;
}

/** A domain request the stores rejected — maps to a 400 at the API edge. */
export class ObjectModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectModelError';
  }
}

const makeRef = (kind: string, value: string) => ({ kind, value });

function timestampNow(): string {
  return new Date().toISOString();
}

/** `updated` must move strictly forward even against a same-instant clock. */
function nextUpdated(previous: unknown): string {
  const floor = typeof previous === 'string' ? Date.parse(previous) || 0 : 0;
  return new Date(Math.max(Date.now(), floor + 1)).toISOString();
}

export class ObjectModel {
  constructor(private readonly roots: ObjectModelRoots) {
    // C1: provision recognized store files once at composition — a fresh
    // stores dir needs no manual touch step, and the CLI's missing-file
    // refusal stays intact for everyone else.
    const created = ensureStoreFiles(roots.storesDir);
    if (created.length > 0) console.log(`[objectModel] provisioned store files in ${roots.storesDir}: ${created.join(', ')}`);
  }

  createTeam(input: { name: string; missionId: string; teamId?: string }): string {
    const id = input.teamId ?? `team_${randomUUID()}`;
    this.append('teams.jsonl', {
      id, kind: 'team', 'ts': timestampNow(), name: input.name,
      refs: [makeRef('mission', input.missionId)],
    });
    return id;
  }

  /**
   * Persist the durable Agent identity. Called BEFORE the Presence (PTY)
   * exists — ruling S4's safe ordering — so a session callback can never
   * target a missing record. The caller passes the one minted id into the
   * terminal runtime afterwards; there is no second mint anywhere.
   */
  createAgent(input: { agentId?: string; name: string; provider: string; teamId: string; missionId: string }): string {
    const id = input.agentId ?? `agent_${randomUUID()}`;
    this.append('agents.jsonl', {
      id, kind: 'agent', 'ts': timestampNow(), name: input.name, provider: input.provider,
      status: 'spawning',
      refs: [makeRef('team', input.teamId), makeRef('mission', input.missionId)],
    });
    return id;
  }

  /**
   * Attach the resolved session (Presence) to the durable Agent. Idempotent
   * and replayable: the same session re-attaching is a no-op; a different
   * session rotates the previous one into `sessions` history.
   * Returns 'unknown' for agents outside the durable model (plain runtime
   * spawns) — that is not an error.
   */
  attachAgentSession(agentId: string, sessionId: string): 'attached' | 'noop' | 'unknown' {
    const current = this.record('agents.jsonl', agentId) as { raw: string; block: AgentBlock } | null;
    if (!current) return 'unknown';
    if (current.block.sessionId === sessionId && current.block.status === 'live') return 'noop';
    this.transition('agents.jsonl', agentId, (block) => {
      const previous = block.sessionId as string | undefined;
      const sessions = previous && previous !== sessionId
        ? [...((block.sessions as string[] | undefined) ?? []), previous]
        : block.sessions;
      return {
        ...block, sessionId, status: 'live',
        ...(sessions ? { sessions } : {}),
        updated: nextUpdated(block.updated),
      };
    });
    return 'attached';
  }

  /** Launch failure leaves an explicit failed record, never silence (S4). */
  markAgentFailed(agentId: string, reason: string): void {
    this.transition('agents.jsonl', agentId, (block) => ({
      ...block, status: 'failed', failureReason: reason, updated: nextUpdated(block.updated),
    }));
  }

  createTask(input: { title: string; missionId: string; agentId?: string; taskId?: string }): string {
    const id = input.taskId ?? `task_${randomUUID().slice(0, 8)}`;
    const timestamp = timestampNow();
    this.append('tasks.jsonl', {
      id, kind: 'task', 'ts': timestamp, title: input.title, status: 'todo', updated: timestamp,
      refs: [makeRef('mission', input.missionId), ...(input.agentId ? [makeRef('agent', input.agentId)] : [])],
    });
    return id;
  }

  transitionTask(taskId: string, status: 'todo' | 'doing' | 'done' | 'blocked', blockedReason?: string): void {
    this.transition('tasks.jsonl', taskId, (block) => {
      const candidate: Record<string, unknown> = { ...block, status, updated: nextUpdated(block.updated) };
      if (status === 'blocked') candidate.blockedReason = blockedReason;
      else delete candidate.blockedReason;
      return candidate;
    });
  }

  /** The typed mission↔messaging link: one thread block per mission room. */
  createThread(input: { roomId: string; missionId: string; threadId?: string }): string {
    const id = input.threadId ?? `thread_${randomUUID().slice(0, 8)}`;
    this.append('threads.jsonl', {
      id, kind: 'thread', 'ts': timestampNow(), roomId: input.roomId,
      refs: [makeRef('mission', input.missionId)],
    });
    return id;
  }

  recordArtifact(input: { title: string; path?: string; url?: string; missionId?: string; taskId?: string; artifactId?: string }): string {
    const id = input.artifactId ?? `artifact_${randomUUID().slice(0, 8)}`;
    this.append('artifacts.jsonl', {
      id, kind: 'artifact', 'ts': timestampNow(), title: input.title,
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.url !== undefined ? { 'url': input.url } : {}),
      refs: [
        ...(input.missionId ? [makeRef('mission', input.missionId)] : []),
        ...(input.taskId ? [makeRef('task', input.taskId)] : []),
      ],
    });
    return id;
  }

  // --- reads the server-side derivations hang on (§1.5) ----------------------

  /** The durable Agent block, or null when the id is outside the model. */
  agentRecord(agentId: string): AgentBlock | null {
    return (this.record('agents.jsonl', agentId)?.block as AgentBlock | undefined) ?? null;
  }

  /** The durable Agent whose CURRENT Presence pointer is this session, or null
   * (mission_visual-truth, Ruling 1b): external registration is idempotent per
   * session — an already-registered session must never mint a second Agent
   * (the chief-kimi-5 double-mint class). */
  agentForSession(sessionId: string): { agentId: string; teamId: string | null } | null {
    for (const entry of this.storeRecords('agents.jsonl')) {
      const block = entry.block as AgentBlock;
      if (block.sessionId !== sessionId) continue;
      const teamRef = block.refs?.find((reference) => reference.kind === 'team');
      return { agentId: block.id, teamId: typeof teamRef?.value === 'string' ? teamRef.value : null };
    }
    return null;
  }

  /** The durable mission block, or null when the id resolves to no mission.
   * Lets write paths pre-validate a mission ref BEFORE any block is appended
   * (external-session registration) instead of discovering a dangling ref
   * after a team is already on disk. */
  missionRecord(missionId: string): Record<string, unknown> | null {
    return this.record('missions.jsonl', missionId)?.block ?? null;
  }

  /** The durable team block, or null when the id resolves to no team. */
  teamRecord(teamId: string): Record<string, unknown> | null {
    return this.record('teams.jsonl', teamId)?.block ?? null;
  }

  /** The mission a durable agent belongs to, from its typed refs. */
  missionForAgent(agentId: string): string | null {
    const block = this.agentRecord(agentId);
    const missionRef = block?.refs?.find((entry) => entry.kind === 'mission');
    return missionRef?.value ?? null;
  }

  /** The mission a runtime room is linked to via its thread block, if any. */
  missionForRoom(roomId: string): string | null {
    const records = this.storeRecords('threads.jsonl');
    const thread = records.find((entry) => (entry.block as { roomId?: string }).roomId === roomId);
    const refs = (thread?.block as { refs?: Array<{ kind: string; value: string }> } | undefined)?.refs;
    return refs?.find((entry) => entry.kind === 'mission')?.value ?? null;
  }

  /** Every durable Agent, folded by id — a replayed/amended line never yields
   * two people (same last-wins law as the store fold). */
  listAgents(): AgentBlock[] {
    const folded = new Map<string, AgentBlock>();
    for (const entry of this.storeRecords('agents.jsonl')) {
      const block = entry.block as AgentBlock;
      if (typeof block?.id === 'string') folded.set(block.id, block);
    }
    return [...folded.values()];
  }

  /** Every durable Team block (N3 room provisioning enumerates them). */
  listTeams(): Array<Record<string, unknown>> {
    return this.storeRecords('teams.jsonl').map((entry) => entry.block as Record<string, unknown>);
  }

  /** Every durable Mission block (N3 room provisioning enumerates them). */
  listMissions(): Array<Record<string, unknown>> {
    return this.storeRecords('missions.jsonl').map((entry) => entry.block as Record<string, unknown>);
  }

  /** Every durable agent on a mission (membership derives from Agent refs — single authority). */
  missionAgents(missionId: string): AgentBlock[] {
    return this.storeRecords('agents.jsonl')
      .map((entry) => entry.block as AgentBlock)
      .filter((block) => block.refs?.some((entry) => entry.kind === 'mission' && entry.value === missionId));
  }

  // --- internals -------------------------------------------------------------

  private append(storeFile: string, block: Record<string, unknown>): void {
    try {
      appendLine(this.roots.storesDir, storeFile, JSON.stringify(block), { baselinePath: this.roots.baselinePath });
    } catch (error) {
      throw this.domainError(error);
    }
  }

  /** CAS transition with re-read retries — a concurrent writer is not a failure. */
  private transition(storeFile: string, id: string, build: (block: Record<string, unknown>) => Record<string, unknown>, attempts = 3): void {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = this.record(storeFile, id);
      if (!current) throw new ObjectModelError(`id "${id}" resolves to no record in ${storeFile}`);
      try {
        replaceLine(this.roots.storesDir, storeFile, id, JSON.stringify(build(current.block)), { expectedRaw: current.raw });
        return;
      } catch (error) {
        if (error instanceof StoreConflictError && attempt < attempts) continue;
        throw this.domainError(error);
      }
    }
  }

  private record(storeFile: string, id: string): { raw: string; block: Record<string, unknown> } | null {
    const entry = this.storeRecords(storeFile).find((candidate) => (candidate.block as { id?: string }).id === id);
    return entry ? { 'raw': entry.raw, block: entry.block as Record<string, unknown> } : null;
  }

  private storeRecords(storeFile: string): Array<{ raw: string; block: unknown }> {
    const snapshot = readStoreDir(this.roots.storesDir) as { files: Record<string, { records: Array<{ raw: string; block: unknown }> }> };
    return snapshot.files[storeFile]?.records ?? [];
  }

  private domainError(error: unknown): Error {
    if (error instanceof StoreValidationError) {
      const violations = (error as unknown as { violations: Array<{ code: string; message: string }> }).violations;
      return new ObjectModelError(violations.map((violation) => `[${violation.code}] ${violation.message}`).join('; '));
    }
    if (error instanceof StoreRefusalError || error instanceof Error) return error as Error;
    return new Error(String(error));
  }
}
