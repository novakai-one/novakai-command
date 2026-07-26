import assert from 'node:assert/strict';
import { parseSnapshot, buildIndex, validateBlock, validateCandidate, auditSnapshot } from './validate.mjs';

// --- helpers -----------------------------------------------------------------

const TS = '2026-07-21T12:00:00+10:00';

/** Minimal fully-valid block per kind (KIND_RULES known-valid shapes). */
const VALID = {
  decision: { id: 'DEC-2026-07-21-001', kind: 'decision', ts: TS, title: 'T', body: 'B' },
  request: { id: 'request_probe', kind: 'request', ts: TS, question: 'Q?', options: ['a', 'b'], status: 'pending' },
  mission: { id: 'mission_probe', kind: 'mission', ts: TS, title: 'T', owner: 'chief-kimi' },
  task: { id: 'task_probe', kind: 'task', ts: TS, title: 'T', status: 'todo' },
  log: { id: 'log_2026-07-21-900', kind: 'log', ts: TS, body: 'observed X' },
  learning: {
    id: 'learning_probe', kind: 'learning', ts: TS, body: 'L',
    evidence: [{ kind: 'log', value: 'log_2026-07-21-900' }],
  },
  objective: { id: 'okr_probe', kind: 'objective', ts: TS, title: 'O', horizon: 'now' },
  kr: { id: 'kr_probe_1', kind: 'kr', ts: TS, objective: 'okr_probe', body: 'K' },
  project: { id: 'proj_probe', kind: 'project', ts: TS, title: 'P', status: 'active', path: '/tmp/x' },
  issue: { id: 'issue_probe', kind: 'issue', ts: TS },
};

const STORE_OF = {
  decision: 'decisions.jsonl', request: 'requests.jsonl', mission: 'missions.jsonl',
  task: 'tasks.jsonl', log: 'captains-log.jsonl', learning: 'learnings.jsonl',
  objective: 'okrs.jsonl', kr: 'okrs.jsonl', project: 'projects.jsonl', issue: 'issues.jsonl',
};

function snapshotOf(blocks) {
  const files = {};
  for (const block of blocks) {
    const file = STORE_OF[block.kind];
    files[file] = (files[file] ?? '') + JSON.stringify(block) + '\n';
  }
  return parseSnapshot(files);
}

function codes(violations) {
  return violations.map((violation) => violation.code).sort();
}

function validateIn(block, extraBlocks = []) {
  const snapshot = snapshotOf([...Object.values(VALID), ...extraBlocks]);
  return validateBlock(block, { storeFile: STORE_OF[block.kind], index: buildIndex(snapshot) });
}

// --- parse + line boundary ---------------------------------------------------

{
  const snapshot = parseSnapshot({ 'tasks.jsonl': 'not json\n' + JSON.stringify(VALID.task) + '\n' });
  const parseViolations = snapshot.files['tasks.jsonl'].violations;
  assert.equal(parseViolations.length, 1);
  assert.equal(parseViolations[0].code, 'PARSE');
  assert.equal(parseViolations[0].line, 1);
  assert.equal(snapshot.files['tasks.jsonl'].records.length, 1); // valid line still parsed
}
{
  // array / scalar lines are PARSE violations too — a line must be one JSON object
  const snapshot = parseSnapshot({ 'tasks.jsonl': '[1,2]\n"str"\n' });
  assert.deepEqual(codes(snapshot.files['tasks.jsonl'].violations), ['PARSE', 'PARSE']);
}
{
  // file whose final line is unterminated → LINE-BOUNDARY
  const snapshot = parseSnapshot({ 'tasks.jsonl': JSON.stringify(VALID.task) });
  assert.deepEqual(codes(snapshot.files['tasks.jsonl'].violations), ['LINE-BOUNDARY']);
}

// --- core shape --------------------------------------------------------------

{
  const violations = validateIn({ ...VALID.task, id: 'task_core-a' });
  assert.deepEqual(violations, []);
}
{
  const { id, ...rest } = VALID.task;
  assert.deepEqual(codes(validateIn(rest)), ['CORE-MISSING']);
}
{
  const { kind, ...rest } = VALID.task;
  assert.ok(codes(validateIn(rest)).includes('CORE-MISSING'));
}
{
  // ts REQUIRED (Chief ruling 3) — created/updated never substitute
  const { ts, ...rest } = { ...VALID.task, id: 'task_core-b', created: TS, updated: TS };
  assert.deepEqual(codes(validateIn(rest)), ['CORE-MISSING']);
}
{
  // ts must be ISO-8601 with offset
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_core-c', ts: '2026-07-21' })), ['CORE-MISSING']);
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_core-d', ts: '2026-07-21T12:00:00' })), ['CORE-MISSING']);
  assert.deepEqual(validateIn({ ...VALID.task, id: 'task_core-e', ts: '2026-07-21T02:00:00Z' }), []);
}

// --- id formats (Chief rulings 1 + 2) ---------------------------------------

{
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'wrongprefix_x' })), ['ID-FORMAT']);
  assert.deepEqual(codes(validateIn({ ...VALID.decision, id: 'decision_x' })), ['ID-FORMAT']); // DEC-* is canonical
  assert.deepEqual(validateIn({ ...VALID.decision, id: 'DEC-2026-07-21-002' }), []);
  assert.deepEqual(codes(validateIn({ ...VALID.objective, id: 'objective_x', title: 'O' })), ['ID-FORMAT']); // okr_* is canonical
  assert.deepEqual(validateIn({ ...VALID.objective, id: 'okr_other' }), []);
  assert.deepEqual(codes(validateIn({ ...VALID.project, id: 'project_x' })), ['ID-FORMAT']); // full proj_*
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_' })), ['ID-FORMAT']); // empty slug
}

// --- wrong store -------------------------------------------------------------

{
  const snapshot = snapshotOf(Object.values(VALID));
  const index = buildIndex(snapshot);
  const violations = validateBlock({ ...VALID.task, id: 'task_wrong-store' }, { storeFile: 'missions.jsonl', index });
  assert.deepEqual(codes(violations), ['WRONG-STORE']);
  // unknown store file name is WRONG-STORE at validation level too
  const unknownStore = validateBlock({ ...VALID.task, id: 'task_unknown-store' }, { storeFile: 'nope.jsonl', index });
  assert.deepEqual(codes(unknownStore), ['WRONG-STORE']);
}

// --- statuses (documented sets enforce; ruling 5 = shape-only for the rest) --

{
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_status-a', status: 'zombie' })), ['STATUS-UNKNOWN']); // doing/blocked joined the set (mission_mission-object-model)
  assert.deepEqual(codes(validateIn({ ...VALID.request, id: 'request_status-a', status: 'open' })), ['STATUS-UNKNOWN']);
  assert.deepEqual(validateIn({ ...VALID.request, id: 'request_status-b', status: 'answered', decision: 'DEC-2026-07-21-001' }), []);
  // shape-only kinds: any string status passes; non-string status is invalid
  assert.deepEqual(validateIn({ ...VALID.mission, id: 'mission_status-a', status: 'retired' }), []);
  assert.deepEqual(codes(validateIn({ ...VALID.mission, id: 'mission_status-b', status: 42 })), ['FIELD-INVALID']);
}

// --- per-kind required fields + horizon --------------------------------------

{
  const { title, ...rest } = { ...VALID.mission, id: 'mission_field-a' };
  assert.deepEqual(codes(validateIn(rest)), ['FIELD-MISSING']);
  const { horizon, ...objectiveRest } = { ...VALID.objective, id: 'okr_field-a' };
  assert.deepEqual(codes(validateIn(objectiveRest)), ['FIELD-MISSING']);
  assert.deepEqual(codes(validateIn({ ...VALID.objective, id: 'okr_field-b', horizon: 'someday' })), ['FIELD-INVALID']);
  const { options, ...requestRest } = { ...VALID.request, id: 'request_field-a' };
  assert.deepEqual(codes(validateIn(requestRest)), ['FIELD-MISSING']);
  assert.deepEqual(codes(validateIn({ ...VALID.request, id: 'request_field-b', options: 'not-an-array' })), ['FIELD-INVALID']);
}

// --- tombstone (Chief ruling 4: status refiled + scalar refiledTo, title optional) --

{
  const tombstone = { id: 'task_tomb-a', kind: 'task', ts: TS, status: 'refiled', refiledTo: 'mission_probe', updated: TS };
  assert.deepEqual(validateIn(tombstone), []);
  // refiled without refiledTo is not a tombstone — RELATION-MISSING
  const half = { id: 'task_tomb-b', kind: 'task', ts: TS, status: 'refiled', updated: TS };
  assert.deepEqual(codes(validateIn(half)), ['RELATION-MISSING']);
  // refiledTo must be a scalar id string, not a typed ref object
  const refObject = { ...tombstone, id: 'task_tomb-c', refiledTo: { kind: 'mission', value: 'mission_probe' } };
  assert.ok(codes(validateIn(refObject)).includes('REF-SHAPE'));
  // dangling tombstone target
  const dangling = { ...tombstone, id: 'task_tomb-d', refiledTo: 'mission_ghost' };
  assert.deepEqual(codes(validateIn(dangling)), ['REF-DANGLING']);
  // tombstone target must be mission|task
  const wrongKind = { ...tombstone, id: 'task_tomb-e', refiledTo: 'log_2026-07-21-900' };
  assert.deepEqual(codes(validateIn(wrongKind)), ['REF-WRONG-KIND']);
}

console.log('validate cycle A tests passed');

// =============================================================================
// Cycle B — index/duplicates, refs, relations, candidate seam, audit
// =============================================================================

// --- index keeps ALL occurrences ---------------------------------------------

{
  const duplicate = { ...VALID.log, id: 'log_2026-07-21-900' }; // same id as VALID.log
  const snapshot = snapshotOf([...Object.values(VALID), duplicate]);
  const index = buildIndex(snapshot);
  assert.equal(index.get('log_2026-07-21-900').length, 2);
}

// --- generic refs ------------------------------------------------------------

{
  // valid resolvable ref passes; doc/exp are declared-unchecked and pass unresolved
  const ok = validateIn({
    ...VALID.task, id: 'task_refs-a',
    refs: [
      { kind: 'mission', value: 'mission_probe', label: 'parent' },
      { kind: 'doc', value: 'docs/nowhere.md' },
      { kind: 'exp', value: 'EXP-2026-01-01-ghost' },
    ],
  });
  assert.deepEqual(ok, []);
}
{
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-b', refs: 'not-an-array' })), ['REF-SHAPE']);
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-c', refs: [{ kind: 'wombat', value: 'x' }] })), ['REF-SHAPE']);
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-d', refs: [{ kind: 'task', value: '' }] })), ['REF-SHAPE']);
  // full proj_* mandated for project refs — a resolvable non-proj value is shape-invalid
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-e', refs: [{ kind: 'project', value: 'novakai-command' }] })), ['REF-SHAPE']);
  // dangling + wrong-kind
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-f', refs: [{ kind: 'mission', value: 'mission_ghost' }] })), ['REF-DANGLING']);
  assert.deepEqual(codes(validateIn({ ...VALID.task, id: 'task_refs-g', refs: [{ kind: 'task', value: 'mission_probe' }] })), ['REF-WRONG-KIND']);
}
{
  // ref to a DUPLICATED id must reject as ambiguous — the index never swallows occurrences
  const duplicate = { ...VALID.mission, id: 'mission_probe' };
  const violations = validateIn(
    { ...VALID.task, id: 'task_refs-h', refs: [{ kind: 'mission', value: 'mission_probe' }] },
    [duplicate],
  );
  assert.deepEqual(codes(violations), ['REF-AMBIGUOUS']);
}

// --- learning evidence -------------------------------------------------------

{
  assert.deepEqual(codes(validateIn({ ...VALID.learning, id: 'learning_ev-a', evidence: [] })), ['RELATION-MISSING']);
  const { evidence, ...rest } = { ...VALID.learning, id: 'learning_ev-b' };
  assert.deepEqual(codes(validateIn(rest)), ['RELATION-MISSING']);
  // doc-only evidence: shape-fine but no log|mission anchor → RELATION-MISSING
  assert.deepEqual(
    codes(validateIn({ ...VALID.learning, id: 'learning_ev-c', evidence: [{ kind: 'doc', value: 'docs/x.md' }] })),
    ['RELATION-MISSING'],
  );
  // doc alongside a log anchor is fine (live learnings do this)
  assert.deepEqual(
    validateIn({
      ...VALID.learning, id: 'learning_ev-d',
      evidence: [{ kind: 'log', value: 'log_2026-07-21-900' }, { kind: 'doc', value: 'docs/x.md' }],
    }),
    [],
  );
  assert.deepEqual(
    codes(validateIn({ ...VALID.learning, id: 'learning_ev-e', evidence: [{ kind: 'log', value: 'log_ghost' }] })),
    ['REF-DANGLING'],
  );
}

// --- kr.objective + answered request → decision ------------------------------

{
  assert.deepEqual(codes(validateIn({ ...VALID.kr, id: 'kr_rel_a', objective: 'okr_ghost' })), ['REF-DANGLING']);
  assert.deepEqual(codes(validateIn({ ...VALID.kr, id: 'kr_rel_b', objective: 'mission_probe' })), ['REF-WRONG-KIND']);
  // Ruling B (Chris, 2026-07-26): objective is optional — a KR with none is legal.
  const { objective, ...krRest } = { ...VALID.kr, id: 'kr_rel_c' };
  assert.deepEqual(validateIn(krRest), []);
  // answered without decision → RELATION-MISSING; with dangling decision → REF-DANGLING
  assert.deepEqual(
    codes(validateIn({ ...VALID.request, id: 'request_rel-a', status: 'answered' })),
    ['RELATION-MISSING'],
  );
  assert.deepEqual(
    codes(validateIn({ ...VALID.request, id: 'request_rel-b', status: 'answered', decision: 'DEC-2026-07-21-999' })),
    ['REF-DANGLING'],
  );
}

// --- kr measurement fields (target/current/unit, all optional) ---------------

{
  assert.deepEqual(
    validateIn({ ...VALID.kr, id: 'kr_meas_a', target: 100, current: 40, unit: 'users' }),
    [],
  );
  // present fields must be numbers when the law says numbers
  assert.deepEqual(codes(validateIn({ ...VALID.kr, id: 'kr_meas_b', target: '100' })), ['FIELD-INVALID']);
  assert.deepEqual(codes(validateIn({ ...VALID.kr, id: 'kr_meas_c', current: '40' })), ['FIELD-INVALID']);
}

// --- nested KRs --------------------------------------------------------------

{
  const nested = { ...VALID.objective, id: 'okr_nested', krs: [{ kind: 'kr', id: 'kr_nested_1' }] };
  assert.deepEqual(codes(validateIn(nested)), ['KR-SHAPE']);
}

// --- validateCandidate (pure write seam) -------------------------------------

{
  const snapshot = snapshotOf(Object.values(VALID));
  const raw = JSON.stringify({ ...VALID.task, id: 'task_cand-a' });
  const result = validateCandidate(raw, { storeFile: 'tasks.jsonl', snapshot });
  assert.deepEqual(result.violations, []);
  assert.equal(result.block.id, 'task_cand-a');
}
{
  const snapshot = snapshotOf(Object.values(VALID));
  // embedded newline → LINE-BOUNDARY at the seam
  const twoLines = JSON.stringify({ ...VALID.task, id: 'task_cand-b' }) + '\n' + JSON.stringify({ ...VALID.task, id: 'task_cand-c' });
  assert.deepEqual(codes(validateCandidate(twoLines, { storeFile: 'tasks.jsonl', snapshot }).violations), ['LINE-BOUNDARY']);
  // non-object / broken JSON → PARSE at the seam
  assert.deepEqual(codes(validateCandidate('{broken', { storeFile: 'tasks.jsonl', snapshot }).violations), ['PARSE']);
  assert.deepEqual(codes(validateCandidate('[1,2]', { storeFile: 'tasks.jsonl', snapshot }).violations), ['PARSE']);
  // duplicate id vs ANY existing id → DUP-ID
  const dupRaw = JSON.stringify({ ...VALID.task, id: 'task_probe' });
  assert.deepEqual(codes(validateCandidate(dupRaw, { storeFile: 'tasks.jsonl', snapshot }).violations), ['DUP-ID']);
}
{
  // M1 candidate isolation: existing drift does NOT block an unrelated clean candidate
  const drifted = { id: 'task_drift', kind: 'task', title: 'no ts' }; // CORE-MISSING drift in store
  const snapshot = snapshotOf([...Object.values(VALID), drifted]);
  const clean = JSON.stringify({ ...VALID.issue, id: 'issue_cand-clean' });
  assert.deepEqual(validateCandidate(clean, { storeFile: 'issues.jsonl', snapshot }).violations, []);
  // ...but a candidate REF into duplicated ids still blocks (tested above via REF-AMBIGUOUS)
}

// --- auditSnapshot -----------------------------------------------------------

{
  const duplicate = { ...VALID.log, id: 'log_2026-07-21-900' };
  const drifted = { id: 'task_drift', kind: 'task', title: 'no ts' };
  const snapshot = snapshotOf([...Object.values(VALID), duplicate, drifted]);
  const audit = auditSnapshot(snapshot);
  const auditCodes = audit.findings.map((finding) => finding.code);
  assert.ok(auditCodes.includes('DUP-ID'), 'duplicate id reported');
  assert.ok(auditCodes.includes('CORE-MISSING'), 'drifted record reported');
  // findings carry store + record id (or line) for per-record reporting
  const dupFinding = audit.findings.find((finding) => finding.code === 'DUP-ID');
  assert.equal(dupFinding.storeFile, 'captains-log.jsonl');
  assert.equal(dupFinding.recordId, 'log_2026-07-21-900');
  assert.ok(dupFinding.line > 0);
  // counts aggregate per store and per code
  assert.ok(audit.countsByCode['DUP-ID'] >= 1);
  assert.ok(audit.countsByStore['tasks.jsonl'] >= 1);
  // Q5 ruling: status census for shape-only kinds reported as info, not violations
  assert.equal(audit.statusCensus.mission.undefined ?? audit.statusCensus.mission['(none)'], 1);
}
{
  // clean snapshot audits clean
  const audit = auditSnapshot(snapshotOf(Object.values(VALID)));
  assert.deepEqual(audit.findings, []);
}

console.log('validate cycle B tests passed');

// =============================================================================
// Cycle C — fixture sets: known-valid audits clean, known-drift reproduces census
// =============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixtureDir(name) {
  const dir = path.join(FIXTURES, name);
  const files = {};
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    files[file] = readFileSync(path.join(dir, file), 'utf8');
  }
  return parseSnapshot(files);
}

{
  // known-valid: a coherent snapshot covering all 10 kinds, a flat kr, and a
  // tombstone — must audit completely clean under the ruled schema.
  const audit = auditSnapshot(loadFixtureDir('known-valid'));
  assert.deepEqual(audit.findings, [], `known-valid must be clean, got: ${JSON.stringify(audit.findings, null, 2)}`);
  const kinds = new Set();
  for (const { records } of Object.values(loadFixtureDir('known-valid').files)) {
    for (const record of records) kinds.add(record.block.kind);
  }
  for (const kind of ['decision', 'request', 'mission', 'task', 'log', 'learning', 'objective', 'kr', 'project', 'issue']) {
    assert.ok(kinds.has(kind), `known-valid missing kind ${kind}`);
  }
}
{
  // known-drift: verbatim live census records — the audit must reproduce the
  // census's violation classes (acceptance fixture set per contract SHOULD).
  const audit = auditSnapshot(loadFixtureDir('known-drift'));
  // Ruling 6 legitimized production's session/objective/request/issue refs, so
  // REF-SHAPE (like ID-FORMAT) is no longer a live drift class — seam rejection
  // of malformed refs stays covered by the write-seam tests.
  const driftCodes = new Set(audit.findings.map((finding) => finding.code));
  for (const code of ['CORE-MISSING', 'DUP-ID', 'REF-AMBIGUOUS', 'REF-DANGLING', 'RELATION-MISSING']) {
    assert.ok(driftCodes.has(code), `known-drift must reproduce ${code}`);
  }
}

console.log('validate cycle C (fixtures) tests passed');

// =============================================================================
// Cycle D — validateTransition (M6: pure seed for future replacement writers;
// no file-rewriting shell exists in this mission)
// =============================================================================

import { validateTransition } from './validate.mjs';

{
  const current = { ...VALID.task, id: 'task_tr', status: 'todo', updated: '2026-07-21T10:00:00+10:00' };
  const done = { ...current, status: 'done', updated: '2026-07-21T14:00:00+10:00' };
  assert.deepEqual(validateTransition(current, done), []);
  // tombstoning an existing record is a legal transition
  const tombstone = { id: 'task_tr', kind: 'task', ts: TS, status: 'refiled', refiledTo: 'mission_probe', updated: '2026-07-21T14:00:00+10:00' };
  assert.deepEqual(validateTransition(current, tombstone), []);
  // id or kind may never change
  assert.deepEqual(codes(validateTransition(current, { ...done, id: 'task_other' })), ['TRANSITION-INVALID']);
  assert.deepEqual(codes(validateTransition(current, { ...done, kind: 'mission' })), ['TRANSITION-INVALID']);
  // status outside the kind's set rejects
  assert.deepEqual(codes(validateTransition(current, { ...done, status: 'zombie' })), ['STATUS-UNKNOWN']); // doing joined the set (mission_mission-object-model)
  // updated must be present and must not move backwards
  const { updated, ...noUpdated } = done;
  assert.deepEqual(codes(validateTransition(current, noUpdated)), ['TRANSITION-INVALID']);
  assert.deepEqual(codes(validateTransition(current, { ...done, updated: '2026-07-21T09:00:00+10:00' })), ['TRANSITION-INVALID']);
}

console.log('validate cycle D (transition) tests passed');
