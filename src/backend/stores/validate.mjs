// Pure validation core for .novakai/stores — no filesystem, no process state.
// Operates on supplied snapshots; the impure edges live in store.mjs (facade).
import {
  STORE_KINDS, REF_KINDS, RESOLVABLE_REF_KINDS, KIND_RULES, TS_PATTERN,
  idPattern, TOMBSTONE_STATUS, TOMBSTONE_TARGET_KINDS, EVIDENCE_TARGET_KINDS,
} from './schema.mjs';

/**
 * @typedef {{code: string, message: string, storeFile: string, recordId?: string, line?: number}} Violation
 * @typedef {{line: number, raw: string, block: object}} StoreRecord
 * @typedef {{files: {[storeFile: string]: {records: StoreRecord[], violations: Violation[]}}}} Snapshot
 */

/** Parse raw store texts ({filename: text}) into a Snapshot. Pure. */
export function parseSnapshot(files) {
  const snapshot = { files: {} };
  for (const [storeFile, text] of Object.entries(files)) {
    const records = [];
    const violations = [];
    const lines = text.split('\n');
    if (text.length > 0 && !text.endsWith('\n')) {
      violations.push({
        code: 'LINE-BOUNDARY',
        message: 'file does not end with a newline — final line is unterminated',
        storeFile,
        line: lines.length,
      });
    } else {
      lines.pop(); // drop the empty tail after the final newline
    }
    lines.forEach((raw, i) => {
      if (raw.trim() === '') return;
      const line = i + 1;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        violations.push({ code: 'PARSE', message: `invalid JSON: ${error.message}`, storeFile, line });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        violations.push({ code: 'PARSE', message: 'line is not a single JSON object', storeFile, line });
        return;
      }
      records.push({ line, raw, block: parsed });
    });
    snapshot.files[storeFile] = { records, violations };
  }
  return snapshot;
}

/** Index every id occurrence — ALL occurrences are kept so duplicates stay visible. */
export function buildIndex(snapshot) {
  const index = new Map();
  for (const [storeFile, { records }] of Object.entries(snapshot.files)) {
    for (const record of records) {
      const id = record.block.id;
      if (typeof id !== 'string' || id === '') continue;
      if (!index.has(id)) index.set(id, []);
      index.get(id).push({ storeFile, line: record.line, block: record.block });
    }
  }
  return index;
}

function resolveTarget(index, value, expectedKinds, addViolation, label) {
  const occurrences = index.get(value);
  if (!occurrences || occurrences.length === 0) {
    addViolation('REF-DANGLING', `${label} "${value}" resolves to no record in any store`);
    return;
  }
  if (occurrences.length > 1) {
    addViolation('REF-AMBIGUOUS', `${label} "${value}" matches ${occurrences.length} records (duplicated id)`);
    return;
  }
  const targetKind = occurrences[0].block.kind;
  if (!expectedKinds.includes(targetKind)) {
    addViolation('REF-WRONG-KIND', `${label} "${value}" is kind "${targetKind}", expected ${expectedKinds.join('|')}`);
  }
}

function validateRefs(block, index, addViolation) {
  if (block.refs === undefined) return;
  if (!Array.isArray(block.refs)) {
    addViolation('REF-SHAPE', '"refs" must be an array of typed refs');
    return;
  }
  block.refs.forEach((ref, i) => {
    const label = `refs[${i}]`;
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      addViolation('REF-SHAPE', `${label} is not a typed-ref object`);
      return;
    }
    if (!REF_KINDS.includes(ref.kind)) {
      addViolation('REF-SHAPE', `${label} kind "${ref.kind}" not in ${REF_KINDS.join('|')}`);
      return;
    }
    if (typeof ref.value !== 'string' || ref.value === '') {
      addViolation('REF-SHAPE', `${label} "value" must be a non-empty string`);
      return;
    }
    if (ref.label !== undefined && typeof ref.label !== 'string') {
      addViolation('REF-SHAPE', `${label} "label" must be a string when present`);
    }
    if (ref.kind === 'project' && !ref.value.startsWith('proj_')) {
      addViolation('REF-SHAPE', `${label} project refs must use the full proj_* id (AGENTS.md ref-integrity)`);
      return;
    }
    if (RESOLVABLE_REF_KINDS.includes(ref.kind)) {
      resolveTarget(index, ref.value, [ref.kind], addViolation, label);
    }
  });
}

function validateScalarRelation(block, field, expectedKinds, required, index, addViolation) {
  const value = block[field];
  if (value === undefined) {
    if (required) addViolation('RELATION-MISSING', `"${field}" is required${block.status ? ` when status is "${block.status}"` : ''}`);
    return;
  }
  if (typeof value !== 'string' || value === '') {
    addViolation('REF-SHAPE', `"${field}" must be a scalar id string`);
    return;
  }
  resolveTarget(index, value, expectedKinds, addViolation, `"${field}"`);
}

function validateEvidence(block, index, addViolation) {
  const evidence = block.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    addViolation('RELATION-MISSING', 'a learning must carry a non-empty "evidence" array (AGENTS.md: evidence ref to a log entry or mission)');
    return;
  }
  let anchored = false;
  evidence.forEach((ref, i) => {
    const label = `evidence[${i}]`;
    if (ref === null || typeof ref !== 'object' || !REF_KINDS.includes(ref.kind) || typeof ref.value !== 'string' || ref.value === '') {
      addViolation('REF-SHAPE', `${label} is not a valid typed ref`);
      return;
    }
    if (EVIDENCE_TARGET_KINDS.includes(ref.kind)) {
      anchored = true;
      resolveTarget(index, ref.value, [ref.kind], addViolation, label);
    } else if (RESOLVABLE_REF_KINDS.includes(ref.kind)) {
      resolveTarget(index, ref.value, [ref.kind], addViolation, label);
    }
  });
  if (!anchored) {
    addViolation('RELATION-MISSING', `evidence must include at least one ref of kind ${EVIDENCE_TARGET_KINDS.join('|')}`);
  }
}

/** Cardinality law from the object-model authority table: refRules = {refKind: {min, max}}. */
function validateRefCardinality(block, rules, addViolation) {
  if (!rules.refRules || !Array.isArray(block.refs)) {
    // A kind with a min>0 rule and no refs array at all still violates.
    for (const [refKind, { min }] of Object.entries(rules.refRules ?? {})) {
      if (min > 0 && !Array.isArray(block.refs)) {
        addViolation('REF-CARDINALITY', `kind "${block.kind}" requires ${min} ref(s) of kind "${refKind}" (authority table)`);
      }
    }
    return;
  }
  for (const [refKind, { min, max }] of Object.entries(rules.refRules)) {
    const count = block.refs.filter((ref) => ref !== null && typeof ref === 'object' && ref.kind === refKind).length;
    if (count < min) {
      addViolation('REF-CARDINALITY', `kind "${block.kind}" requires at least ${min} ref(s) of kind "${refKind}", found ${count}`);
    }
    if (count > max) {
      addViolation('REF-CARDINALITY', `kind "${block.kind}" allows at most ${max} ref(s) of kind "${refKind}", found ${count}`);
    }
  }
}

/**
 * Conditional task authority (correction M1), WRITE-STRICT ONLY: a NEW task
 * that refs a mission must name exactly one agent, and that agent's mission
 * must agree. Legacy agentless mission-tasks in the stores stay valid (the
 * unassigned bucket renders them) — audits never gain findings from this.
 */
function validateTaskAuthority(block, index, addViolation) {
  const refs = Array.isArray(block.refs) ? block.refs : [];
  const refValue = (kind) => refs.find((entry) => entry !== null && typeof entry === 'object' && entry.kind === kind)?.value;
  const missionId = refValue('mission');
  if (typeof missionId !== 'string') return;
  const agentId = refValue('agent');
  if (typeof agentId !== 'string') {
    addViolation('REF-CARDINALITY', 'a new mission task must ref exactly one agent (authority table, M1) — legacy records are exempt');
    return;
  }
  const occurrences = index.get(agentId);
  if (!occurrences || occurrences.length !== 1 || occurrences[0].block.kind !== 'agent') return; // dangling/ambiguous already violates
  const agentRefs = Array.isArray(occurrences[0].block.refs) ? occurrences[0].block.refs : [];
  const agentMission = agentRefs.find((entry) => entry !== null && typeof entry === 'object' && entry.kind === 'mission')?.value;
  if (agentMission !== undefined && agentMission !== missionId) {
    addViolation('RELATION-INCONSISTENT', `task refs mission "${missionId}" but its agent "${agentId}" refs mission "${agentMission}" — they must agree`);
  }
}

/** blockedReason iff blocked (plan v2 §1.1) — both directions are violations. */
function validateBlockedReason(block, addViolation) {
  const blocked = block.status === 'blocked';
  const reason = block.blockedReason;
  if (blocked && (typeof reason !== 'string' || reason.trim() === '')) {
    addViolation('FIELD-MISSING', 'a blocked task must carry a non-empty "blockedReason"');
  }
  if (!blocked && reason !== undefined) {
    addViolation('FIELD-INVALID', '"blockedReason" is only allowed when status is "blocked"');
  }
}

/**
 * An artifact names exactly one location (path xor url). It carries NO anchor
 * requirement — see schema.mjs: an artifact is created parentless and attached
 * afterwards through ordinary refs (Chris, 2026-07-26).
 */
function validateArtifactShape(block, addViolation) {
  const hasPath = typeof block.path === 'string' && block.path !== '';
  const hasUrl = typeof block.url === 'string' && block.url !== '';
  if (hasPath === hasUrl) {
    addViolation('FIELD-INVALID', 'an artifact must carry exactly one of "path" or "url"');
  }
}

/**
 * Agent↔Team mission agreement (authority table): the agent's team must ref
 * the same mission the agent refs. Only checked when both sides resolve
 * cleanly — dangling/ambiguous refs are already their own violations.
 */
function validateAgentTeamConsistency(block, index, addViolation) {
  const refs = Array.isArray(block.refs) ? block.refs : [];
  const refValue = (kind) => refs.find((ref) => ref !== null && typeof ref === 'object' && ref.kind === kind)?.value;
  const teamId = refValue('team');
  const missionId = refValue('mission');
  if (typeof teamId !== 'string' || typeof missionId !== 'string') return;
  const teamOccurrences = index.get(teamId);
  if (!teamOccurrences || teamOccurrences.length !== 1 || teamOccurrences[0].block.kind !== 'team') return;
  const teamRefs = Array.isArray(teamOccurrences[0].block.refs) ? teamOccurrences[0].block.refs : [];
  const teamMission = teamRefs.find((ref) => ref !== null && typeof ref === 'object' && ref.kind === 'mission')?.value;
  if (teamMission !== undefined && teamMission !== missionId) {
    addViolation('RELATION-INCONSISTENT', `agent refs mission "${missionId}" but its team "${teamId}" refs mission "${teamMission}" — they must agree`);
  }
}

function validateNestedKrs(block, addViolation) {
  for (const [field, value] of Object.entries(block)) {
    if (!Array.isArray(value)) continue;
    if (value.some((item) => item !== null && typeof item === 'object' && item.kind === 'kr')) {
      addViolation('KR-SHAPE', `objective field "${field}" nests kr blocks — KRs are flat blocks in okrs.jsonl (AGENTS.md)`);
    }
  }
}

/**
 * Validate one block in the context of a store file and a cross-store id index.
 * Duplicate-id detection is contextual (audit/candidate), not part of this check.
 * @returns {Violation[]}
 */
export function validateBlock(block, { storeFile, index = new Map(), mode = 'audit' }) {
  const violations = [];
  const recordId = typeof block.id === 'string' && block.id !== '' ? block.id : undefined;
  const addViolation = (code, message) => violations.push({ code, message, storeFile, recordId });

  if (recordId === undefined) addViolation('CORE-MISSING', '"id" is required and must be a non-empty string');
  const kind = block.kind;
  if (typeof kind !== 'string' || kind === '') {
    addViolation('CORE-MISSING', '"kind" is required and must be a non-empty string');
    return violations;
  }
  if (typeof block.ts !== 'string' || !TS_PATTERN.test(block.ts)) {
    addViolation('CORE-MISSING', '"ts" is required on every new write, ISO-8601 with offset (Chief ruling 3 — created/updated never substitute)');
  }
  if (recordId !== undefined && !idPattern(kind).test(recordId)) {
    addViolation('ID-FORMAT', `id "${recordId}" does not match the canonical shape for kind "${kind}" (${idPattern(kind)})`);
  }

  const allowedKinds = STORE_KINDS[storeFile];
  if (!allowedKinds) {
    addViolation('WRONG-STORE', `"${storeFile}" is not a recognized store file`);
  } else if (!allowedKinds.includes(kind)) {
    addViolation('WRONG-STORE', `kind "${kind}" is not allowed in ${storeFile} (allowed: ${allowedKinds.join(', ')})`);
  }

  validateRefs(block, index, addViolation);

  const rules = KIND_RULES[kind];
  if (!rules) return violations; // unknown kind already flagged via WRONG-STORE

  if (block.status === TOMBSTONE_STATUS) {
    // Ruling 4: tombstone = status "refiled" + scalar refiledTo; title optional.
    validateScalarRelation(block, 'refiledTo', TOMBSTONE_TARGET_KINDS, true, index, addViolation);
    return violations;
  }

  for (const field of rules.required) {
    if (block[field] === undefined) addViolation('FIELD-MISSING', `"${field}" is required for kind "${kind}"`);
  }
  for (const field of rules.arrays ?? []) {
    if (block[field] !== undefined && !Array.isArray(block[field])) {
      addViolation('FIELD-INVALID', `"${field}" must be an array`);
    }
  }
  for (const [field, allowed] of Object.entries(rules.enums ?? {})) {
    if (block[field] !== undefined && !allowed.includes(block[field])) {
      addViolation('FIELD-INVALID', `"${field}" must be one of ${allowed.join('|')}`);
    }
  }
  if (block.status !== undefined) {
    if (rules.statusSet) {
      if (!rules.statusSet.includes(block.status)) {
        addViolation('STATUS-UNKNOWN', `status "${block.status}" not in the documented set for kind "${kind}" (${rules.statusSet.join('|')}, or "${TOMBSTONE_STATUS}" as a tombstone)`);
      }
    } else if (typeof block.status !== 'string') {
      addViolation('FIELD-INVALID', '"status" must be a string');
    }
  }

  validateRefCardinality(block, rules, addViolation);

  if (kind === 'learning') validateEvidence(block, index, addViolation);
  if (kind === 'kr' && block.objective !== undefined) {
    validateScalarRelation(block, 'objective', ['objective'], false, index, addViolation);
  }
  if (kind === 'request' && block.status === 'answered') {
    validateScalarRelation(block, 'decision', ['decision'], true, index, addViolation);
  }
  if (kind === 'objective') validateNestedKrs(block, addViolation);
  if (kind === 'task') validateBlockedReason(block, addViolation);
  if (kind === 'task' && mode === 'candidate') validateTaskAuthority(block, index, addViolation);
  if (kind === 'mission' && mode === 'candidate') {
    // M1/M10: a mission names at most one project (write-strict; legacy audits exempt).
    const projectRefs = (Array.isArray(block.refs) ? block.refs : [])
      .filter((entry) => entry !== null && typeof entry === 'object' && entry.kind === 'project');
    if (projectRefs.length > 1) {
      addViolation('REF-CARDINALITY', `kind "mission" allows at most 1 ref of kind "project", found ${projectRefs.length}`);
    }
  }
  if (kind === 'artifact') validateArtifactShape(block, addViolation);
  if (kind === 'agent') validateAgentTeamConsistency(block, index, addViolation);

  return violations;
}

/**
 * Pure write seam: validate one raw JSON line as a candidate append.
 * M1 candidate isolation — only the candidate's own violations, an id collision
 * with ANY existing id, and candidate refs into missing/ambiguous targets block;
 * pre-existing drift elsewhere in the snapshot never does.
 * @returns {{violations: Violation[], block?: object}}
 */
export function validateCandidate(rawLine, { storeFile, snapshot }) {
  if (/[\r\n]/.test(rawLine)) {
    return {
      violations: [{
        code: 'LINE-BOUNDARY',
        message: 'a candidate must be exactly one line — embedded newlines are rejected',
        storeFile,
      }],
    };
  }
  let block;
  try {
    block = JSON.parse(rawLine);
  } catch (error) {
    return { violations: [{ code: 'PARSE', message: `invalid JSON: ${error.message}`, storeFile }] };
  }
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { violations: [{ code: 'PARSE', message: 'candidate is not a single JSON object', storeFile }] };
  }
  const index = buildIndex(snapshot);
  const violations = validateBlock(block, { storeFile, index, mode: 'candidate' });
  if (typeof block.id === 'string' && index.has(block.id)) {
    violations.push({
      code: 'DUP-ID',
      message: `id "${block.id}" already exists in ${index.get(block.id).map((occurrence) => occurrence.storeFile).join(', ')}`,
      storeFile,
      recordId: block.id,
    });
  }
  return { violations, block };
}

/**
 * Pure validation of a proposed in-place replacement (state transition).
 * Grown from the M6 seed into the enforcement behind replaceLine
 * (mission_mission-object-model ruling S3): id/kind immutable, destination
 * status legal, and `updated` STRICTLY monotonic on parsed instants — equal
 * or lexically-tricky offset timestamps are rejected, never string-compared.
 * Field-level deltas beyond these are judged by the full-candidate
 * validateBlock pass the writer runs against the post-transition snapshot.
 * @returns {Violation[]}
 */
export function validateTransition(currentBlock, candidateBlock) {
  const violations = [];
  const storeFile = '(transition)';
  const addViolation = (code, message) => violations.push({ code, message, storeFile, recordId: currentBlock.id });
  if (candidateBlock.id !== currentBlock.id) addViolation('TRANSITION-INVALID', 'a transition may never change "id"');
  if (candidateBlock.kind !== currentBlock.kind) addViolation('TRANSITION-INVALID', 'a transition may never change "kind"');
  const rules = KIND_RULES[currentBlock.kind];
  if (rules?.statusSet && candidateBlock.status !== undefined
    && candidateBlock.status !== TOMBSTONE_STATUS
    && !rules.statusSet.includes(candidateBlock.status)) {
    addViolation('STATUS-UNKNOWN', `status "${candidateBlock.status}" not in the documented set for kind "${currentBlock.kind}"`);
  }
  if (typeof candidateBlock.updated !== 'string' || !TS_PATTERN.test(candidateBlock.updated)) {
    addViolation('TRANSITION-INVALID', '"updated" must be present (ISO-8601 with offset) on a transition (AGENTS.md: keep updated current)');
  } else if (typeof currentBlock.updated === 'string' && TS_PATTERN.test(currentBlock.updated)) {
    const currentInstant = Date.parse(currentBlock.updated);
    const candidateInstant = Date.parse(candidateBlock.updated);
    if (!(candidateInstant > currentInstant)) {
      addViolation('TRANSITION-INVALID', `"updated" must move strictly forward in time (${candidateBlock.updated} is not after ${currentBlock.updated})`);
    }
  }
  return violations;
}

const SHAPE_ONLY_STATUS_KINDS = Object.freeze(
  Object.entries(KIND_RULES).filter(([, rules]) => rules.statusSet === null).map(([kind]) => kind),
);

/**
 * Audit a full snapshot: every parse-level violation plus every per-record
 * violation, each finding carrying store / record id / line. Duplicate ids are
 * reported on every occurrence after the first. Status census for shape-only
 * kinds is info (Chief ruling 5), never a violation.
 * @returns {{findings: Violation[], countsByStore: object, countsByCode: object, statusCensus: object}}
 */
export function auditSnapshot(snapshot) {
  const findings = [];
  const statusCensus = {};
  const index = buildIndex(snapshot);
  for (const [storeFile, { records, violations }] of Object.entries(snapshot.files)) {
    findings.push(...violations);
    for (const record of records) {
      const recordFindings = validateBlock(record.block, { storeFile, index })
        .map((violation) => ({ ...violation, line: record.line }));
      findings.push(...recordFindings);
      const id = record.block.id;
      if (typeof id === 'string' && index.get(id)?.[0] !== undefined) {
        const occurrences = index.get(id);
        const isFirstOccurrence = occurrences[0].storeFile === storeFile && occurrences[0].line === record.line;
        if (occurrences.length > 1 && !isFirstOccurrence) {
          findings.push({
            code: 'DUP-ID',
            message: `id "${id}" occurs ${occurrences.length} times (first at ${occurrences[0].storeFile}:${occurrences[0].line})`,
            storeFile,
            recordId: id,
            line: record.line,
          });
        }
      }
      const kind = record.block.kind;
      if (SHAPE_ONLY_STATUS_KINDS.includes(kind)) {
        statusCensus[kind] = statusCensus[kind] ?? {};
        const status = typeof record.block.status === 'string' ? record.block.status : '(none)';
        statusCensus[kind][status] = (statusCensus[kind][status] ?? 0) + 1;
      }
    }
  }
  const countsByStore = {};
  const countsByCode = {};
  for (const finding of findings) {
    countsByStore[finding.storeFile] = (countsByStore[finding.storeFile] ?? 0) + 1;
    countsByCode[finding.code] = (countsByCode[finding.code] ?? 0) + 1;
  }
  return { findings, countsByStore, countsByCode, statusCensus };
}
