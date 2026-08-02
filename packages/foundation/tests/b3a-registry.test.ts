// B3a — Foundation additive registration proof (B3V4-P2 §18.1, AMD-001 A-01).
//
// The manifest test is the guard against the failure mode the amendment exists
// to prevent: a Build 3 record kind that exists in one registry but not the
// others, or a capability quietly writing another capability's store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, mintClientOpId,
  OBJECT_KINDS, REFERENCE_KINDS,
  type CapabilityId, type ObjectKind,
} from '../contract/index.js';
import { KIND_FILES, RECORD_KINDS } from '../core/store-engine/engine.js';

/**
 * The complete inventory this build registers, kind → file → owning capability.
 * Pass 2 §18.1 lists the whole B3 target; B3a registers the rows it owns and
 * later slices extend this table. Equality (not subset) is the point: a kind
 * added to one registry and forgotten in another fails here.
 */
const EXPECTED: ReadonlyArray<readonly [ObjectKind, string, CapabilityId]> = [
  ['agent', 'agents.jsonl', 'agents'],
  ['skill', 'skills.jsonl', 'agents'],
  ['layout', 'layout.jsonl', 'shell'],
  ['settings', 'settings.jsonl', 'shell'],
  ['conversationView', 'conversationViews.jsonl', 'shell'],
  ['config', 'config.jsonl', 'server'],
  ['providerSession', 'providerSessions.jsonl', 'agents'],
  ['project', 'projects.jsonl', 'projects'],
  ['projectItem', 'projectItems.jsonl', 'projects'],
  ['artifact', 'artifacts.jsonl', 'artifacts'],
  ['spineStep', 'spineSteps.jsonl', 'spine'],
  ['transcriptLine', 'transcriptLines.jsonl', 'transcript'],
  ['transcriptJournal', 'transcriptJournal.jsonl', 'transcript'],
  ['transcriptCheckpoint', 'transcriptCheckpoints.jsonl', 'transcript'],
  // ── B3a additions ──────────────────────────────────────────────────────
  ['runtimeEpoch', 'runtimeEpochs.jsonl', 'agent-runtime'],
  ['commandReceipt', 'commandReceipts.jsonl', 'foundation'],
  ['terminalSession', 'terminalSessions.jsonl', 'terminal'],
  ['controllerAttachment', 'controllerAttachments.jsonl', 'terminal'],
  ['terminalInputLease', 'terminalInputLeases.jsonl', 'terminal'],
  ['terminalInputAttempt', 'terminalInputAttempts.jsonl', 'terminal'],
  // ── B3b additions ──────────────────────────────────────────────────────
  ['agentRoleProfile', 'agentRoleProfiles.jsonl', 'agents'],
  ['resolvedLaunchPlan', 'resolvedLaunchPlans.jsonl', 'agents'],
  ['agentRelationship', 'agentRelationships.jsonl', 'agents'],
  ['delegationGrant', 'delegationGrants.jsonl', 'agents'],
  ['controlReplacementPlan', 'controlReplacementPlans.jsonl', 'agents'],
  ['agentRun', 'agentRuns.jsonl', 'agent-runtime'],
  ['runContinuation', 'runContinuations.jsonl', 'agent-runtime'],
  ['supervisionAssignment', 'supervisionAssignments.jsonl', 'agent-runtime'],
  ['treeMutationFence', 'treeMutationFences.jsonl', 'agent-runtime'],
  ['runOperation', 'runOperations.jsonl', 'agent-runtime'],
  // ── B3c additions ──────────────────────────────────────────────────────
  ['messagingStoreOp', 'messagingStoreOps.jsonl', 'messaging'],
  ['transcriptBinding', 'transcriptBindings.jsonl', 'transcript'],
  ['observedSubagent', 'observedSubagents.jsonl', 'transcript'],
  ['storeRouteCutover', 'storeRouteCutovers.jsonl', 'foundation'],
  // ── B3d additions ──────────────────────────────────────────────────────
  ['watchRule', 'watchRules.jsonl', 'supervision'],
  ['watchDeadline', 'watchDeadlines.jsonl', 'supervision'],
  ['notification', 'notifications.jsonl', 'supervision'],
];

/** The three named special cases §18.1 allows to sit outside the ordinary path. */
const SPECIAL_CASES = ['token', 'trace', 'quarantine'] as const;

test('manifest equality: OBJECT_KINDS, KIND_FILES and RECORD_KINDS agree', () => {
  const expectedKinds = EXPECTED.map(([kind]) => kind).sort();

  // OBJECT_KINDS = ordinary kinds + the named special cases, nothing else.
  const objectKinds = [...OBJECT_KINDS].sort();
  assert.deepEqual(objectKinds, [...expectedKinds, ...SPECIAL_CASES].sort(),
    'OBJECT_KINDS drifted from the expected inventory');

  // Every ordinary kind has exactly the expected file; token is the only
  // registered kind with no KIND_FILES row (it is directory-backed).
  for (const [kind, file] of EXPECTED) {
    assert.equal((KIND_FILES as Record<string, string>)[kind], file,
      `KIND_FILES[${kind}] must be ${file}`);
  }
  const fileKinds = Object.keys(KIND_FILES).sort();
  assert.deepEqual(fileKinds, [...expectedKinds, 'trace', 'quarantine'].sort(),
    'KIND_FILES drifted from the expected inventory');

  // RECORD_KINDS = ordinary wrapped-record stores. trace keeps its
  // engine-private journal line and must never appear here.
  const recordKinds = [...RECORD_KINDS].sort();
  assert.deepEqual(recordKinds, [...expectedKinds, 'quarantine'].sort(),
    'RECORD_KINDS drifted from the expected inventory');
  assert.equal(RECORD_KINDS.includes('trace'), false,
    'trace is engine-private and is not an ordinary record kind');

  // Two files may never collide.
  const files = Object.values(KIND_FILES);
  assert.equal(new Set(files).size, files.length, 'two kinds share one file');

  // Reference kinds are a superset of object kinds (never a write grant).
  for (const kind of OBJECT_KINDS) {
    assert.equal(REFERENCE_KINDS.includes(kind), true, `${kind} missing from REFERENCE_KINDS`);
  }
});

test('every B3a/B3c kind round-trips through its owning scoped handle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3a-registry-'));
  try {
    const b3a = EXPECTED.filter(
      ([kind]) => B3A_KINDS.has(kind) || B3C_KINDS.has(kind) || B3D_KINDS.has(kind),
    );
    for (const [kind, file, capability] of b3a) {
      const handle = composeHandle({
        root, capability, allowedKinds: [kind], principal: 'sys_foundation',
      });
      const created = await createObject(handle, {
        kind, id: `${kind}_roundtrip`, schemaVersion: 1,
        createdAt: new Date().toISOString(),
        permissionLevel: 'private', createdBy: 'caller_is_not_trusted',
      }, mintClientOpId());
      assert.equal(created.ok, true, `${kind} did not round-trip through ${capability}`);
      assert.equal(existsSync(path.join(root, file)), true, `${file} was not created`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a B3a kind is refused through every foreign handle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3a-scope-'));
  try {
    // Terminal may not write the Runtime's epoch, and Agent Runtime may not
    // write Terminal's session — red gate 18 in executable form.
    const cases: ReadonlyArray<readonly [CapabilityId, ObjectKind, ObjectKind]> = [
      ['terminal', 'terminalSession', 'runtimeEpoch'],
      ['agent-runtime', 'runtimeEpoch', 'terminalSession'],
      ['terminal', 'terminalSession', 'commandReceipt'],
      // B3c: Messaging owns its StoreOp journal; Transcript owns custody. The
      // one thing red gate 18 forbids is either reaching into the other.
      ['transcript', 'transcriptBinding', 'messagingStoreOp'],
      ['messaging', 'messagingStoreOp', 'transcriptBinding'],
      ['messaging', 'messagingStoreOp', 'observedSubagent'],
      // The cutover receipt is Foundation-bootstrap-only (§18.1).
      ['messaging', 'messagingStoreOp', 'storeRouteCutover'],
      // B3d: Supervision owns watchers, deadlines and notifications, and no
      // other capability may write one — the seam lanes B and C both cross.
      ['supervision', 'watchRule', 'agentRun'],
      ['agent-runtime', 'agentRun', 'watchRule'],
      ['agent-runtime', 'agentRun', 'notification'],
      ['messaging', 'messagingStoreOp', 'watchDeadline'],
    ];
    for (const [capability, granted, forbidden] of cases) {
      const handle = composeHandle({
        root, capability, allowedKinds: [granted], principal: 'sys_foundation',
      });
      const attempt = await createObject(handle, {
        kind: forbidden, id: `${forbidden}_forbidden`, schemaVersion: 1,
        createdAt: new Date().toISOString(),
        permissionLevel: 'private', createdBy: 'caller_is_not_trusted',
      }, mintClientOpId());
      assert.equal(attempt.ok, false, `${capability} wrote ${forbidden}`);
      if (!attempt.ok) assert.equal(attempt.error.code, 'ScopeViolation');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const B3A_KINDS = new Set<string>([
  'runtimeEpoch', 'commandReceipt', 'terminalSession',
  'controllerAttachment', 'terminalInputLease', 'terminalInputAttempt',
]);

const B3D_KINDS = new Set<string>(['watchRule', 'watchDeadline', 'notification']);

const B3C_KINDS = new Set<string>([
  'messagingStoreOp', 'transcriptBinding', 'observedSubagent', 'storeRouteCutover',
]);
