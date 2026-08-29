import type {
  AdoptionAssignment,
  AgentDirectory,
} from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { NormalizedProviderLine } from '../../contract/ports/provider-transcript-source.js';
import type { AgentIdentityMarker } from '../../contract/records/agent-identity.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { IngestFailureKind } from '../../contract/runtime.js';
import type { Timestamp } from '../../contract/types.js';
import { present } from '../send/sparse.js';
import { adoptProviderSession } from './adopt-session.js';
import { assignProviderSession } from './assign-session.js';
import type { ClassificationStore } from './ingest-store.js';

/** Runtime policy required before Messaging may make an external session visible. */
export interface ExternalAdoptionRuntimePolicy {
  readonly assignment: AdoptionAssignment;
  readonly conversations: ConversationDirectory;
  readonly limitPerTick: number;
}

/**
 * Outside evidence that contradicts itself or names things this store does
 * not know. Provider files are external input, so these are typed outcomes —
 * the source fails this pass with evidence — never thrown strings.
 */
export interface EvidenceRejection {
  readonly kind: 'reject';
  readonly failure: IngestFailureKind;
  readonly message: string;
}

/** What one source's evidence says to do with its session this pass. */
export type SessionClassification =
  | { readonly kind: 'commit'; readonly session: ProviderSession; readonly adopted: boolean }
  | {
      readonly kind: 'defer';
      readonly status: 'adoption-pending' | 'discovered-only';
      readonly foreign?: boolean;
    }
  | EvidenceRejection;

/** Who the identity markers in one source's lines belong to. */
type MarkerOwnership =
  | { readonly kind: 'owned'; readonly markers: readonly AgentIdentityMarker[] }
  | { readonly kind: 'foreign' };

interface ClassificationInput {
  readonly session: ProviderSession;
  readonly lines: readonly NormalizedProviderLine[];
  readonly complete: boolean;
  readonly adoptionEligible: boolean;
  readonly adoptionRemaining: number;
  readonly store: ClassificationStore;
  readonly directory?: AgentDirectory;
  readonly adoption?: ExternalAdoptionRuntimePolicy;
  readonly storeId?: string;
  readonly now: () => Timestamp;
}

/** Narrows input to one where adoption is fully composed — no assertions needed after. */
const adoptionReady = (
  input: ClassificationInput,
): input is ClassificationInput & {
  readonly directory: AgentDirectory;
  readonly adoption: ExternalAdoptionRuntimePolicy;
} => input.adoptionEligible && input.directory !== undefined && input.adoption !== undefined;

/**
 * Chooses hook assignment, external adoption, metadata-only discovery, or
 * rejection — the single decision point for what one source's session becomes.
 */
export async function classifyProviderSession(
  input: ClassificationInput,
): Promise<SessionClassification> {
  const ownership = await markerOwnershipFor(input);
  if (ownership.kind !== 'owned') return deferralFor(ownership);
  if (input.session.agentId !== undefined || ownership.markers.length > 0) {
    return commitAssignedSession(input, ownership.markers);
  }
  return adoptOrDefer(input);
}

/** Identity evidence for one source's lines: owned by this store, foreign, or rejected. */
async function markerOwnershipFor(
  input: ClassificationInput,
): Promise<MarkerOwnership | EvidenceRejection> {
  const markers = input.lines.flatMap((line) =>
    line.agentIdentity === undefined ? [] : [line.agentIdentity]);
  if (markers.length === 0) return { kind: 'owned', markers: [] };
  return resolveMarkerOwnership(input, markers);
}

/** Foreign evidence defers as discovered-only; rejected evidence fails the source loudly. */
const deferralFor = (
  ownership: MarkerOwnership | EvidenceRejection,
): SessionClassification =>
  ownership.kind === 'reject'
    ? ownership
    : { kind: 'defer', status: 'discovered-only', foreign: true };

/** Markers split by schema version and by which store the v2 ones name. */
const splitMarkers = (
  markers: readonly AgentIdentityMarker[],
  storeId: string | undefined,
): {
  readonly ours: readonly AgentIdentityMarker[];
  readonly foreignV2: readonly AgentIdentityMarker[];
  readonly legacy: readonly AgentIdentityMarker[];
} => ({
  ours: markers.filter((marker) => marker.schemaVersion === 2 && marker.storeId === storeId),
  foreignV2: markers.filter((marker) => marker.schemaVersion === 2 && marker.storeId !== storeId),
  legacy: markers.filter((marker) => marker.schemaVersion === 1),
});

/** Evidence naming both this store and a foreign one contradicts itself — rejected. */
const mixedOwnership = (split: {
  readonly ours: readonly AgentIdentityMarker[];
  readonly foreignV2: readonly AgentIdentityMarker[];
}, sessionId: string): EvidenceRejection | undefined =>
  split.ours.length > 0 && split.foreignV2.length > 0
    ? {
      kind: 'reject',
      failure: 'session-conflict',
      message: `ProviderSession ${sessionId} mixes store ownership markers`,
    }
    : undefined;

/**
 * Decides whether the identity markers belong to this store, a foreign
 * store, or no one — or rejects the evidence when it contradicts itself.
 */
async function resolveMarkerOwnership(
  input: ClassificationInput,
  markers: readonly AgentIdentityMarker[],
): Promise<MarkerOwnership | EvidenceRejection> {
  const split = splitMarkers(markers, input.storeId);
  const mixed = mixedOwnership(split, input.session.id);
  if (mixed !== undefined) return mixed;
  if (split.ours.length > 0) return verifyOwnedMarkers(input, split.ours);
  if (split.foreignV2.length > 0) return { kind: 'foreign' };
  return resolveLegacyMarkers(split.legacy, input.directory);
}

/**
 * Verifies v2 markers that name this store: they need the AgentDirectory
 * composed, and every marker must name a known Agent.
 */
async function verifyOwnedMarkers(
  input: ClassificationInput,
  ours: readonly AgentIdentityMarker[],
): Promise<MarkerOwnership | EvidenceRejection> {
  if (input.directory === undefined) {
    return {
      kind: 'reject',
      failure: 'dependency-unavailable',
      message: `ProviderSession ${input.session.id} carries owned identity without AgentDirectory`,
    };
  }
  const missing = await missingAgentIds(ours, input.directory);
  if (missing.length > 0) {
    return {
      kind: 'reject',
      failure: 'agent-unknown',
      message: `Owned identity marker names missing Agent ${missing.join(', ')}`,
    };
  }
  return { kind: 'owned', markers: ours };
}

/** Legacy v1 markers predate store ownership; only the known-Agent ones still count. */
async function resolveLegacyMarkers(
  legacy: readonly AgentIdentityMarker[],
  directory: AgentDirectory | undefined,
): Promise<MarkerOwnership> {
  if (legacy.length === 0 || directory === undefined) return { kind: 'foreign' };
  const missing = new Set(await missingAgentIds(legacy, directory));
  const known = legacy.filter((marker) => !missing.has(marker.agentId));
  return known.length === 0 ? { kind: 'foreign' } : { kind: 'owned', markers: known };
}

/** Ids of Agents the directory does not know, in marker order. */
async function missingAgentIds(
  markers: readonly AgentIdentityMarker[],
  directory: AgentDirectory,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const marker of markers) {
    if (await directory.get(marker.agentId) === null) missing.push(marker.agentId);
  }
  return missing;
}

/** Commits with the sole assignment writer; hook markers or an external agent id both count as identity. */
async function commitAssignedSession(
  input: ClassificationInput,
  markers: readonly AgentIdentityMarker[],
): Promise<SessionClassification> {
  return {
    kind: 'commit',
    adopted: false,
    session: await assignProviderSession({
      session: input.session,
      store: input.store,
      markers,
      ...present('externalAgentId', input.session.agentId),
      ...present('directory', input.directory),
      now: input.now,
    }),
  };
}

/** Adopts an external session when policy allows; anything less stays metadata-only. */
async function adoptOrDefer(input: ClassificationInput): Promise<SessionClassification> {
  if (!adoptionReady(input)) return { kind: 'defer', status: 'discovered-only' };
  const blocker = await adoptionBlocker(input);
  if (blocker !== undefined) return { kind: 'defer', status: blocker };
  return {
    kind: 'commit',
    adopted: true,
    session: await adoptProviderSession({
      session: input.session,
      store: input.store,
      directory: input.directory,
      conversations: input.adoption.conversations,
      assignment: input.adoption.assignment,
      now: input.now,
    }),
  };
}

/** Why an adoption-ready session still waits this pass, or undefined when it may adopt now. */
async function adoptionBlocker(
  input: ClassificationInput & {
    readonly directory: AgentDirectory;
    readonly adoption: ExternalAdoptionRuntimePolicy;
  },
): Promise<'adoption-pending' | undefined> {
  const mustWait = !input.complete
    || input.adoptionRemaining === 0
    || await matchesPendingFreshSend(input);
  return mustWait ? 'adoption-pending' : undefined;
}

/**
 * A fresh user send still awaiting session assignment protects its provider's
 * external sessions from adoption: the session the provider just created is
 * probably that send's, so adoption waits for the hook evidence.
 */
async function matchesPendingFreshSend(
  input: ClassificationInput & { readonly directory: AgentDirectory },
): Promise<boolean> {
  const userTexts = new Set(input.lines
    .filter((line) => line.role === 'user')
    .map((line) => line.text));
  for (const journal of await input.store.listSendJournals()) {
    if (await journalMatchesFreshSend(journal, userTexts, input)) return true;
  }
  return false;
}

/** One journal matches when it awaits assignment, repeats a user line, and targets this provider. */
async function journalMatchesFreshSend(
  journal: SendJournal,
  userTexts: ReadonlySet<string>,
  input: { readonly directory: AgentDirectory; readonly session: ProviderSession },
): Promise<boolean> {
  if (journal.state !== 'awaiting-session-assignment' || !userTexts.has(journal.request.text)) {
    return false;
  }
  const agent = await input.directory.get(journal.targetAgentId);
  return agent?.provider === input.session.provider;
}
