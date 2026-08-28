// A managed Run is not a child of whoever started the Runtime — §8.2, §13.5.
//
// Found by the hold-out exam's own PTY, not by reading code. Exam rows C1/C3
// (claude) typed a real human turn into a real claude PTY and found nothing
// mirrored, and the raw terminal tail said why:
//
//   ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
//
// `mergedEnvironment` copies the Runtime host's whole environment into every
// PTY it launches. When the Runtime is itself started from inside a Claude Code
// session — which is how Novakai is developed, and how the desktop app is
// launched from a terminal — that marker rides along, the provider concludes it
// is a nested invocation, and it writes NO transcript file. There is then
// nothing on disk for §8.2 custody to take, and the mirror is reading a file
// the provider deliberately did not write.
//
// The marker names the HOST's session. A spawned Agent Run is a first-class
// session with its own reserved id, so it does not inherit that sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintProviderSessionId, mintResolvedLaunchPlanId, nowIsoUtc,
  type RecordVersion,
} from '@novakai/foundation/contract';
import type { ResolvedLaunchPlan } from '../contract/records.js';
import { createClaudeAdapter } from '../adapters/providers/claude.js';
import { roleInput } from './harness.js';

function planFor(workingDirectory: string): ResolvedLaunchPlan {
  const role = roleInput();
  return {
    kind: 'resolvedLaunchPlan',
    id: mintResolvedLaunchPlanId(),
    schemaVersion: 1,
    recordVersion: 1 as RecordVersion,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: 'person_chris' as never,
    lastMutation: { state: 'legacy-no-trace' },
    agentId: 'agent_00000000-0000-4000-8000-000000000000' as never,
    roleProfile: { id: 'agentRole_x', version: 1, digest: 'digest' },
    provider: 'claude',
    modelId: 'opus',
    effort: 'high',
    workingDirectory,
    skills: role.skillRefs,
    hooks: [],
    instructions: [],
    skillsConfirmationGate: role.skillsConfirmationGate,
    executionPolicy: {
      policyRef: role.executionPolicyRef,
      commandScopes: [], filesystemScopes: [], networkScopes: [],
      enforcement: 'advisory', limitations: [],
    },
    spawnPolicy: role.spawnPolicy,
    lifecyclePolicy: role.lifecyclePolicy,
    supervisionPolicy: role.supervisionPolicy,
    budgetPolicy: role.budgetPolicy,
    resolutionFingerprint: 'fingerprint',
  };
}

test('a claude Run does not inherit the host session marker that suppresses its transcript',
  async () => {
    const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-inherited-'));
    try {
      const adapter = createClaudeAdapter({
        cliPath: '/bin/echo',
        environment: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          CLAUDE_CODE_CHILD_SESSION: '1',
        },
      });
      const built = await adapter.buildLaunch(planFor(workingDirectory), {
        workingDirectory,
        columns: 120,
        rows: 40,
        reservedProviderSessionId: mintProviderSessionId(),
        runtimeEnvironment: { NVK_AGENT_RUN_ID: 'agentRun_x' },
      });
      assert.equal(built.ok, true, built.ok ? '' : `${built.error.code}: ${built.error.message}`);
      if (!built.ok) return;

      assert.equal('CLAUDE_CODE_CHILD_SESSION' in built.value.environment, false,
        'the Runtime host\'s child-session marker was passed to a managed Run, and the '
        + 'provider will write no transcript for it');

      // The environment a spawned Agent needs to authenticate as itself is
      // untouched (DEC-B3V4-05) — this removes a leak, it does not sanitise.
      assert.equal(built.value.environment['NVK_AGENT_RUN_ID'], 'agentRun_x');
      assert.equal(built.value.environment['PATH'], process.env['PATH'] ?? '');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

test('the marker is not inherited on a continuation either', async () => {
  const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-inherited-cont-'));
  try {
    const adapter = createClaudeAdapter({
      cliPath: '/bin/echo',
      environment: {
        PATH: process.env['PATH'] ?? '',
        CLAUDE_CODE_CHILD_SESSION: '1',
      },
    });
    const built = await adapter.buildContinuation({
      mode: 'resume',
      launchPlan: planFor(workingDirectory),
      workingDirectory,
      columns: 120,
      rows: 40,
      oldSession: {
        providerSessionId: mintProviderSessionId(),
        providerNativeSessionId: '00000000-0000-4000-8000-000000000000',
      },
      reservedProviderSessionId: mintProviderSessionId(),
      runtimeEnvironment: { NVK_AGENT_RUN_ID: 'agentRun_y' },
    } as never);
    assert.equal(built.ok, true, built.ok ? '' : `${built.error.code}: ${built.error.message}`);
    if (!built.ok) return;
    assert.equal('CLAUDE_CODE_CHILD_SESSION' in built.value.environment, false,
      'a continued Run inherited the host marker and will write no transcript');
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});
