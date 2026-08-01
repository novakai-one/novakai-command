// B3b — Foundation additive registration proof for governed Runs (§18.1, AMD-001 A-01).
//
// Ten new kinds, two owners, one engine. The manifest-equality half lives in
// `b3a-registry.test.ts` because there is exactly ONE inventory and it must be
// stated in exactly one place; this file proves the half that only B3b can
// prove — that each new kind writes through its owner's handle and through no
// other (red gates 18 and 25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, mintClientOpId,
  type CapabilityId, type ObjectKind,
} from '../contract/index.js';

const AGENTS_KINDS: readonly ObjectKind[] = [
  'agentRoleProfile', 'resolvedLaunchPlan', 'agentRelationship',
  'delegationGrant', 'controlReplacementPlan',
];

const RUNTIME_KINDS: readonly ObjectKind[] = [
  'agentRun', 'runContinuation', 'supervisionAssignment',
  'treeMutationFence', 'runOperation',
];

const FILES: Readonly<Record<string, string>> = {
  agentRoleProfile: 'agentRoleProfiles.jsonl',
  resolvedLaunchPlan: 'resolvedLaunchPlans.jsonl',
  agentRelationship: 'agentRelationships.jsonl',
  delegationGrant: 'delegationGrants.jsonl',
  controlReplacementPlan: 'controlReplacementPlans.jsonl',
  agentRun: 'agentRuns.jsonl',
  runContinuation: 'runContinuations.jsonl',
  supervisionAssignment: 'supervisionAssignments.jsonl',
  treeMutationFence: 'treeMutationFences.jsonl',
  runOperation: 'runOperations.jsonl',
};

async function writeThrough(
  root: string, capability: CapabilityId, allowed: readonly ObjectKind[], kind: ObjectKind,
): ReturnType<typeof createObject> {
  const handle = composeHandle({
    root, capability, allowedKinds: allowed, principal: 'sys_foundation',
  });
  return createObject(handle, {
    kind, id: `${kind}_roundtrip`, schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: 'private', createdBy: 'caller_is_not_trusted',
  }, mintClientOpId());
}

test('every B3b kind round-trips through its owning scoped handle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-registry-'));
  try {
    const owners: ReadonlyArray<readonly [CapabilityId, readonly ObjectKind[]]> = [
      ['agents', AGENTS_KINDS],
      ['agent-runtime', RUNTIME_KINDS],
    ];
    for (const [capability, kinds] of owners) {
      for (const kind of kinds) {
        const created = await writeThrough(root, capability, kinds, kind);
        assert.equal(created.ok, true, `${kind} did not round-trip through ${capability}`);
        assert.equal(existsSync(path.join(root, FILES[kind]!)), true,
          `${FILES[kind]} was not created`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a B3b kind is refused through every foreign handle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-scope-'));
  try {
    // Red gate 18 in executable form, both directions: Agent Runtime may not
    // write a role profile, and Agents may not write a Run. Terminal may write
    // neither — a third capability proves the refusal is not a two-way special
    // case.
    const cases: ReadonlyArray<readonly [CapabilityId, readonly ObjectKind[], ObjectKind]> = [
      ['agent-runtime', RUNTIME_KINDS, 'agentRoleProfile'],
      ['agent-runtime', RUNTIME_KINDS, 'delegationGrant'],
      ['agents', AGENTS_KINDS, 'agentRun'],
      ['agents', AGENTS_KINDS, 'runOperation'],
      ['terminal', ['terminalSession'], 'agentRun'],
      ['terminal', ['terminalSession'], 'agentRoleProfile'],
    ];
    for (const [capability, allowed, forbidden] of cases) {
      const attempt = await writeThrough(root, capability, allowed, forbidden);
      assert.equal(attempt.ok, false, `${capability} wrote ${forbidden}`);
      if (!attempt.ok) assert.equal(attempt.error.code, 'ScopeViolation');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
