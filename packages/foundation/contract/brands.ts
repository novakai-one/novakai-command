// §1 Branded Identifier Types (Pass 2 S1 contracts).
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ObjectId = Brand<string, 'objectId'>;
export type AgentId = Brand<string, 'agentId'>;
export type PersonId = Brand<string, 'personId'>;
export type SessionId = Brand<string, 'sessionId'>;
export type ProjectId = Brand<string, 'projectId'>;
export type ArtifactId = Brand<string, 'artifactId'>;
export type ConversationId = Brand<string, 'conversationId'>;

// §3.2 has two lawful sources: caller-minted UUIDv4 command keys and
// name-derived UUIDv5 saga-effect keys. Both retain the same `op_` authority.
export type ClientOpId = Brand<string, 'clientOpId'>; // "op_<uuidv4|uuidv5>" — REQUIRED on all mutating ops (R3-10)
export type ServerOpId = Brand<string, 'serverOpId'>; // "srv_<uuidv4>"

// B3a (B3V4-P2 §4.4): each capability that mutates on its own behalf — rather
// than on behalf of a human — gets a named system principal, so `createdBy`
// stays trusted and attributable instead of collapsing into one "system".
export type SystemPrincipal =
  | 'sys_ingester' | 'sys_reconciler' | 'sys_spine'
  | 'sys_foundation' | 'sys_agents' | 'sys_agent_runtime'
  | 'sys_terminal' | 'sys_messaging' | 'sys_transcript'
  | 'sys_supervision' | 'sys_shell';
export type Principal = AgentId | PersonId | SystemPrincipal;

// Runtime schemas and TypeScript consumers share this one authoritative
// registry. Adding a kind here updates both the compile-time union and the
// boundary validator used by capabilities that persist refs.
export const OBJECT_KINDS = [
  'agent',
  'skill',
  'layout',
  'settings',
  'conversationView', // S2 F1/DEC-S2-11: shell-owned pin/archive view state
  'config',           // B1 DEC-B1-3: server-owned typed config objects
  'providerSession',  // B1 DEC-B1-6: agents-owned resumable provider handles
  'project',          // B2a DEC-B2-1: projects-owned durable identity/lifecycle
  'projectItem',      // B2a DEC-B2-1: projects-owned reference membership
  'artifact',         // B2a DEC-B2-2: artifacts-owned metadata; bytes stay outside JSONL
  'spineStep',        // B2a DEC-B2-3: spine-owned immutable workflow journal fact
  'transcriptLine',       // B2b DEC-B2-4: transcript-owned normalized line
  'transcriptJournal',    // B2b DEC-B2-4: transcript-owned ingestion journal
  'transcriptCheckpoint', // B2b DEC-B2-4: transcript-owned incremental cursor
  // B3a (B3V4-P2 §18.1, AMD-001 A-01): additive registration only — Build 3
  // records ride Foundation's existing engine, envelope, lock, CAS and trace.
  'runtimeEpoch',         // DEC-B3V4-27: runtime-host-owned split-brain fence
  'commandReceipt',       // DEC-B3V4-30: foundation-owned idempotency receipt
  'terminalSession',      // DEC-B3V4-01: terminal-owned PTY session
  'controllerAttachment', // DEC-B3V4-08: terminal-owned controller attachment
  'terminalInputLease',   // DEC-B3V4-29: terminal-owned single-writer lease
  'terminalInputAttempt', // DEC-B3V4-29: terminal-owned ordered input outcome
  'notificationInputReservation', // B3d Q7: terminal-owned delivery fence
  // B3b (B3V4-P2 §§5, 6, 18.1): governed Runs, roles, family and delegation.
  // Agents owns the first five; Agent Runtime owns the last five (§3.3).
  'agentRoleProfile',       // DEC-B3V4-03: agents-owned reusable governed role
  'resolvedLaunchPlan',     // DEC-B3V4-03/31: agents-owned immutable pinned plan
  'agentRelationship',      // DEC-B3V4-06: agents-owned immutable spawn edge
  'delegationGrant',        // DEC-B3V4-12: agents-owned run-scoped authority
  'controlReplacementPlan', // DEC-B3V4-31: agents-owned signed control replacement
  'agentRun',               // DEC-B3V4-02: runtime-owned one provider context
  'runContinuation',        // DEC-B3V4-19: runtime-owned resume/fresh/compact/handover
  'supervisionAssignment',  // DEC-B3V4-07: runtime-owned reassignable supervision
  'treeMutationFence',      // DEC-B3V4-11: runtime-owned stop-tree fence
  'runOperation',           // DEC-B3V4-26: runtime-owned recoverable stage journal
  // B3c (B3V4-P2 §§8, 18.1): Messages, transcript custody, and the one receipt
  // that lets a legacy route retire. Messaging's whole atomic StoreOp is ONE
  // record here — Message/Thread/Delivery/acceptance/endpoint/inbox stay
  // entities inside its payload and get no file of their own (§18.1).
  'messagingStoreOp',   // DEC-B3V4-33: messaging-owned atomic operation journal
  'transcriptBinding',  // DEC-B3V4-24: transcript-owned Run↔source custody
  'observedSubagent',   // DEC-B3V4-18: transcript-owned observed native subagent
  'storeRouteCutover',  // DEC-B3V4-25: foundation-bootstrap-only cutover receipt
  // B3d (B3V4-P2 §§5.5, 9.1, 9.2, 18.1): Agents retains provider usage
  // evidence; Supervision owns standing rules, durable deadlines, and alerts.
  'providerUsageEvidence', // agents-owned append-only provider measurement
  'watchRule',          // DEC-B3V4-07: supervision-owned standing watcher rule
  'watchDeadline',      // supervision-owned generation-fenced durable deadline
  'notification',       // supervision-owned queued/delivered alert
  'watchEvaluation',    // AMD-003: supervision-owned resumable rule evaluation
  'notificationDeliveryFenceOperation', // AMD-003: supervision-owned Run rebind progress
  'quarantine',
  'token',
  'trace',
] as const;

export type ObjectKind = typeof OBJECT_KINDS[number];

// Durable refs may name records owned by capabilities whose persistence is
// outside Foundation's store engine. Keep this registry distinct from
// OBJECT_KINDS so reference validation never grants write scope.
export const REFERENCE_KINDS = [
  ...OBJECT_KINDS,
  'message',
] as const;

export type ReferenceKind = typeof REFERENCE_KINDS[number];

export type CapabilityId =
  | 'foundation' | 'shell' | 'agents' | 'messaging'
  | 'terminal' | 'transcript' | 'projects' | 'artifacts' | 'spine'
  | 'server' // B1: the production composition root (owns kind 'config')
  | 'agent-runtime' // B3a DEC-B3V4-22: sole writer of Run/runtime truth
  | 'supervision'; // B3d: watchers, deadlines, notifications

// ── Mint helpers (identity conventions: foundation owns conventions, §8) ──
import { createHash, randomUUID } from 'node:crypto';

export const mintClientOpId = (): ClientOpId => `op_${randomUUID()}` as ClientOpId;

/**
 * The idempotency key for ONE saga effect (§3.2: "every external saga effect
 * derives its idempotency key from the receipt plus stage name").
 *
 * A random key per attempt makes a retry a second effect, and one key shared by
 * two different effects makes the second a silently swallowed replay of the
 * first — the two failure modes that cost B3b its seal. Deriving the key from
 * the effect's own name makes a retry a retry and keeps two effects distinct,
 * with no state to carry between attempts.
 *
 * The UUID shape is honoured, with version nibble 5: this IS a name-derived
 * UUID, and claiming version 4 would assert entropy that is deliberately absent.
 */
export const deriveClientOpId = (effectKey: string): ClientOpId => {
  const digest = createHash('sha256').update(`nvk-effect:${effectKey}`, 'utf8').digest('hex');
  const version = `5${digest.slice(13, 16)}`;
  // RFC 4122 variant: the high bits of the 17th hex digit must be 10xx.
  const variant = `${'89ab'[parseInt(digest[16]!, 16) & 0b11]!}${digest.slice(17, 20)}`;
  return `op_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${version}-${variant}-${digest.slice(20, 32)}` as ClientOpId;
};

const CLIENT_OP_ID = /^op_[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Accept the two §3.2 ClientOpId forms without weakening prefix/version/variant checks. */
export const isValidClientOpId = (value: unknown): value is ClientOpId =>
  typeof value === 'string' && CLIENT_OP_ID.test(value);

export const mintServerOpId = (): ServerOpId => `srv_${randomUUID()}` as ServerOpId;
export const mintObjectId = (kind: string): ObjectId => `${kind}_${randomUUID()}` as ObjectId;
