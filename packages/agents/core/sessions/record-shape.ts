// The providerSession record shape and its parser.
//
// A logical agents session (`sess_<uuid>`) maps to a PROVIDER CONVERSATION id.
// Physical CLI processes come and go under it, so what has to survive a server
// restart is the resumable HANDLE, not a process:
//
//     sessionId · agentId · provider · providerConversationId · cwd · model
//     spawnedAt · lastActivityAt · turns · status · inFlight · lastInterruption
//
// These records are handles, never durable identity. Nothing derives an
// identity from a pid or a provider session id.
//
// A stored object is PARSED, never cast. A record that does not carry this
// shape (for example a governed handle record wrongly written under the same
// kind) becomes a typed `malformed` result the caller can skip and report — it
// never becomes a runtime TypeError three modules later.
import type { ProviderName } from '../../contract/schemas.js';

export type ProviderSessionStatus = 'running' | 'closed' | 'exited';

export interface InFlightTurn {
  clientOpId: string;
  pid: number | null;
  pidStartedAt: string | null;
}

export interface InFlightState {
  /** Compatibility summary of the oldest queued provider turn. */
  clientOpId: string | null;
  status: 'generating' | 'none';
  pid: number | null;
  pidStartedAt: string | null;
  /** One durable flag per queued turn, in provider execution order. */
  queue: InFlightTurn[];
}

/** Transcript-derived accounting persisted on the logical provider session. */
export interface ProviderSessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  source: string;
  measuredAt: string;
  /** Present only when the measurement is a provably safe subset. */
  usagePartial?: true;
}

/** Typed explanation for why a usage measurement could not be made. */
export interface ProviderSessionUsageUnavailable {
  code: 'UsageUnavailable';
  reason: string;
  checkedAt: string;
}

export type ProviderSessionUsageMeasurement =
  | ({ kind: 'measured' } & ProviderSessionTokenUsage)
  | { kind: 'unavailable'; reason: string; checkedAt: string };

export interface ProviderSessionRecord {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  /** The provider's own conversation id — the resume handle (kimi: `-S <id>`). */
  providerConversationId: string | null;
  cwd: string;
  model: string;
  spawnedAt: string;
  lastActivityAt: string;
  turns: number;
  status: ProviderSessionStatus;
  inFlight: InFlightState;
  /** Set by the boot sweep; cleared when the operator resends. */
  lastInterruption: { clientOpId: string; at: string; reason: 'ReplyInterrupted' } | null;
  /** Backfilled by supervision from provider transcript evidence. */
  tokenUsage: ProviderSessionTokenUsage | null;
  /** Mutually exclusive with tokenUsage; absence is explicit, never a dash-only mystery. */
  usageUnavailable: ProviderSessionUsageUnavailable | null;
}

export type ParsedProviderSessionRecord =
  | { ok: true; record: ProviderSessionRecord }
  | { ok: false; id: string; reason: string };

const inFlightFrom = (queue: InFlightTurn[]): InFlightState => {
  const head = queue[0];
  return {
    clientOpId: head?.clientOpId ?? null,
    status: head ? 'generating' : 'none',
    pid: head?.pid ?? null,
    pidStartedAt: head?.pidStartedAt ?? null,
    queue,
  };
};

export { inFlightFrom };

export function normalizeInFlight(raw: Partial<InFlightState> | undefined): InFlightState {
  if (Array.isArray(raw?.queue)) {
    return inFlightFrom(raw.queue.map((turn) => ({
      clientOpId: turn.clientOpId,
      pid: turn.pid ?? null,
      pidStartedAt: turn.pidStartedAt ?? null,
    })));
  }
  if (raw?.status === 'generating' && raw.clientOpId) {
    return inFlightFrom([{
      clientOpId: raw.clientOpId,
      pid: raw.pid ?? null,
      pidStartedAt: raw.pidStartedAt ?? null,
    }]);
  }
  return inFlightFrom([]);
}

const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'kimi', 'mock']);
const STATUSES: ReadonlySet<string> = new Set(['running', 'closed', 'exited']);

/**
 * Parse one stored object of kind `providerSession`. Returns the typed record,
 * or `{ ok: false, id, reason }` naming what was missing. Never throws because
 * of stored data.
 */
export function parseProviderSessionRecord(object: Record<string, unknown>): ParsedProviderSessionRecord {
  const raw = object as Record<string, unknown>;
  const id = typeof raw.sessionId === 'string'
    ? raw.sessionId
    : typeof raw.id === 'string' ? raw.id : '<no id>';
  const missing: string[] = [];
  if (typeof raw.sessionId !== 'string') missing.push('sessionId');
  if (typeof raw.agentId !== 'string') missing.push('agentId');
  if (typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider)) missing.push('provider');
  if (typeof raw.cwd !== 'string') missing.push('cwd');
  if (typeof raw.model !== 'string') missing.push('model');
  if (typeof raw.spawnedAt !== 'string') missing.push('spawnedAt');
  if (typeof raw.lastActivityAt !== 'string') missing.push('lastActivityAt');
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) missing.push('status');
  if (missing.length > 0) {
    return { ok: false, id, reason: `not a registry providerSession record — missing/invalid: ${missing.join(', ')}` };
  }
  return {
    ok: true,
    record: {
      sessionId: raw.sessionId as string,
      agentId: raw.agentId as string,
      provider: raw.provider as ProviderName,
      providerConversationId: typeof raw.providerConversationId === 'string' ? raw.providerConversationId : null,
      cwd: raw.cwd as string,
      model: raw.model as string,
      spawnedAt: raw.spawnedAt as string,
      lastActivityAt: raw.lastActivityAt as string,
      turns: typeof raw.turns === 'number' ? raw.turns : 0,
      status: raw.status as ProviderSessionStatus,
      inFlight: normalizeInFlight(raw.inFlight as Partial<InFlightState> | undefined),
      lastInterruption: (raw.lastInterruption ?? null) as ProviderSessionRecord['lastInterruption'],
      tokenUsage: (raw.tokenUsage ?? null) as ProviderSessionRecord['tokenUsage'],
      usageUnavailable: (raw.usageUnavailable ?? null) as ProviderSessionRecord['usageUnavailable'],
    },
  };
}
