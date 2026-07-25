// Schema law for .novakai/stores — INTERNAL to src/backend/stores/ (facade: store.mjs).
// Sources: AGENTS.md store conventions + Chief rulings Q1–Q5 pinned verbatim in
// .novakai/work/mission_store-validator/authorization.md, extended by the
// mission_mission-object-model plan v2 rulings (edge/cardinality/authority
// table, §1.0–1.1). KIND_RULES implements the rulings' exact words, not any
// paraphrase.

/** filename → kinds allowed in that store */
export const STORE_KINDS = Object.freeze({
  'decisions.jsonl': Object.freeze(['decision']),
  'requests.jsonl': Object.freeze(['request']),
  'missions.jsonl': Object.freeze(['mission']),
  'tasks.jsonl': Object.freeze(['task']),
  'captains-log.jsonl': Object.freeze(['log']),
  'learnings.jsonl': Object.freeze(['learning']),
  'okrs.jsonl': Object.freeze(['objective', 'kr']),
  'projects.jsonl': Object.freeze(['project']),
  'issues.jsonl': Object.freeze(['issue']),
  // Object model: the durable half of Project → Objective → KR → Mission →
  // Team → Agent → Tasks → Artifacts. thread carries the mission↔messaging link.
  'teams.jsonl': Object.freeze(['team']),
  'agents.jsonl': Object.freeze(['agent']),
  'artifacts.jsonl': Object.freeze(['artifact']),
  'threads.jsonl': Object.freeze(['thread']),
});

// Ruling 7 (Chief, 2026-07-21, supersedes ruling 6), extended by
// mission_mission-object-model (Chief addition: `thread` is repository law):
// team|agent|artifact|thread join the allowed ref kinds.
export const REF_KINDS = Object.freeze(['task', 'mission', 'project', 'doc', 'decision', 'log', 'exp', 'objective', 'request', 'issue', 'session', 'learning', 'team', 'agent', 'artifact', 'thread']);

/** Ref kinds whose targets live in these stores; doc/exp/session are declared-unchecked. */
export const RESOLVABLE_REF_KINDS = Object.freeze(['task', 'mission', 'project', 'decision', 'log', 'objective', 'request', 'issue', 'learning', 'team', 'agent', 'artifact', 'thread']);

const SLUG = '[A-Za-z0-9][A-Za-z0-9_.-]*';

// Ruling 1: DEC-YYYY-MM-DD-NNN canonical for decision. Ruling 2: okr_* for objective.
const ID_PATTERNS = Object.freeze({
  decision: /^DEC-\d{4}-\d{2}-\d{2}-\d{3}$/,
  objective: new RegExp(`^okr_${SLUG}$`),
  project: new RegExp(`^proj_${SLUG}$`),
});

export function idPattern(kind) {
  return ID_PATTERNS[kind] ?? new RegExp(`^${kind}_${SLUG}$`);
}

// Ruling 3: ts REQUIRED on new writes, ISO-8601 with offset (Z accepted as explicit UTC).
export const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

// Ruling 5: kinds with no documented status set get shape-only enforcement
// (statusSet: null); status census is audit info, never a violation.
//
// refRules encode the object-model cardinality/authority table (plan v2 §1.0):
// each entry is refKind → {min, max} on that kind's typed refs. Only the NEW
// kinds carry mins — legacy records (tasks without agent refs, missions
// without project refs) stay valid by construction, so the canonical store
// gains no new findings from this law.
export const KIND_RULES = Object.freeze({
  decision: Object.freeze({ required: Object.freeze(['title', 'body']), statusSet: null }),
  request: Object.freeze({
    required: Object.freeze(['question', 'options']),
    arrays: Object.freeze(['options']),
    statusSet: Object.freeze(['pending', 'answered']),
  }),
  mission: Object.freeze({ required: Object.freeze(['title', 'owner']), statusSet: null }),
  // Object-model amendment: doing/blocked join the documented set; a blocked
  // task must say why (blockedReason iff blocked — enforced in validate.mjs).
  task: Object.freeze({
    required: Object.freeze(['title']),
    statusSet: Object.freeze(['todo', 'doing', 'done', 'blocked']),
    refRules: Object.freeze({ agent: Object.freeze({ min: 0, max: 1 }), mission: Object.freeze({ min: 0, max: 1 }) }),
  }),
  log: Object.freeze({ required: Object.freeze(['body']), statusSet: null }),
  learning: Object.freeze({ required: Object.freeze(['body']), statusSet: null }),
  objective: Object.freeze({
    required: Object.freeze(['title', 'horizon']),
    enums: Object.freeze({ horizon: Object.freeze(['now', 'next', 'later']) }),
    statusSet: null,
  }),
  kr: Object.freeze({ required: Object.freeze(['objective', 'body']), statusSet: null }),
  project: Object.freeze({ required: Object.freeze(['title', 'status', 'path']), statusSet: null }),
  issue: Object.freeze({ required: Object.freeze([]), statusSet: null }),
  // Team is the shell for future expansion — membership is NOT stored here:
  // it derives from Agent → team refs (single authority, plan ruling S4/L14).
  team: Object.freeze({
    required: Object.freeze(['name']),
    statusSet: null,
    refRules: Object.freeze({ mission: Object.freeze({ min: 1, max: 1 }) }),
  }),
  // The durable Novakai identity (≈ CONTEXT.md Person). sessionId is its
  // CURRENT Presence pointer; prior values rotate into the `sessions` history
  // array so an overwrite never erases Presence history (ruling M13).
  // F3 amendment: team/mission refs are multi-membership (min 1, no max) —
  // co-membership has always been union semantics over these refs
  // (messagingV2/policy), and ops-service identities (nvk-watchdog) must be
  // co-member with EVERY team and mission or their alerts terminally fail
  // delivery to everyone else.
  agent: Object.freeze({
    required: Object.freeze(['name', 'provider']),
    arrays: Object.freeze(['sessions']),
    statusSet: Object.freeze(['spawning', 'live', 'failed', 'retired']),
    refRules: Object.freeze({
      team: Object.freeze({ min: 1, max: Number.POSITIVE_INFINITY }),
      mission: Object.freeze({ min: 1, max: Number.POSITIVE_INFINITY }),
    }),
  }),
  // Exactly one of path|url, and at least one mission/task anchor — both
  // enforced in validate.mjs (the either-or shapes don't fit required[]).
  artifact: Object.freeze({ required: Object.freeze(['title']), statusSet: null }),
  // The mission↔messaging link: resolvable mission ref + scalar roomId, a
  // runtime identifier deliberately unchecked against runtime state (same
  // class as `session` refs).
  thread: Object.freeze({
    required: Object.freeze(['roomId']),
    statusSet: null,
    refRules: Object.freeze({ mission: Object.freeze({ min: 1, max: 1 }) }),
  }),
});

/** Artifact anchor rule: at least one ref of one of these kinds (plan v2 §1.0). */
export const ARTIFACT_ANCHOR_KINDS = Object.freeze(['mission', 'task']);

// Ruling 4: tombstone = status "refiled" + scalar refiledTo (title optional).
export const TOMBSTONE_STATUS = 'refiled';
export const TOMBSTONE_TARGET_KINDS = Object.freeze(['mission', 'task']);

/** Evidence on a learning must include at least one ref to one of these kinds. */
export const EVIDENCE_TARGET_KINDS = Object.freeze(['log', 'mission']);
