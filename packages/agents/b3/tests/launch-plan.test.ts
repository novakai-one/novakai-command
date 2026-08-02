// Roles and pinned launch plans (B3V4-P2 §§5.2–5.3, 12.1, 13.5; DEC-B3V4-03/31).
//
// This is where B3b's public proof "forbidden role/control overrides fail
// WITHOUT spawning" is actually decided. Everything downstream — Agent, Run,
// PTY, provider — happens only after resolution succeeds, so a refusal here is
// a refusal with no effects to undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRig, roleInput, chatRoleInput, CHRIS } from './harness.js';
import type { AgentRoleProfileId, RecordVersion } from '@novakai/foundation/contract';

async function withRig<T>(work: (rig: ReturnType<typeof createRig>) => Promise<T>): Promise<T> {
  const rig = createRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

/** Create a role and an Agent standing on it — the setup nearly every test needs. */
async function seed(
  rig: ReturnType<typeof createRig>, role = roleInput(),
): Promise<{ roleId: AgentRoleProfileId; agentId: string; roleVersion: RecordVersion }> {
  const created = await rig.agents.createRoleProfile(rig.human(), role);
  assert.equal(created.ok, true, 'role profile was not created');
  if (!created.ok) throw new Error('unreachable');
  const agent = await rig.agents.createAgentFromRole(rig.human(), {
    roleProfileId: created.value.id,
    displayName: 'Builder One',
    rootHumanPrincipalId: CHRIS,
  });
  assert.equal(agent.ok, true, 'agent was not created from the role');
  if (!agent.ok) throw new Error('unreachable');
  return {
    roleId: created.value.id,
    agentId: agent.value.agent.id,
    roleVersion: created.value.recordVersion,
  };
}

test('a role resolves to a plan pinned with its defaults', async () => {
  await withRig(async (rig) => {
    const { roleId, agentId, roleVersion } = await seed(rig);
    const resolved = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.provider, 'claude');
    assert.equal(resolved.value.modelId, 'opus');
    assert.equal(resolved.value.effort, 'high');
    assert.equal(resolved.value.workingDirectory, '/tmp/work');
    assert.deepEqual(resolved.value.skills.map((item) => item.id), ['tdd', 'verification-before-completion']);
    // The plan records exactly WHICH role version it froze (DEC-B3V4-31).
    assert.equal(resolved.value.roleProfile.id, roleId);
    assert.equal(resolved.value.roleProfile.version, roleVersion);
    assert.equal(resolved.value.executionPolicy.enforcement, 'advisory',
      'Novakai cannot enforce OS command restriction and must not claim it (red gate 21)');
  });
});

test('activity drift pins durable start-turn authority in the resolved plan', async () => {
  await withRig(async (rig) => {
    const role = roleInput({
      supervisionPolicy: {
        activityDrift: 'required',
        requiredWatcherTemplates: [],
        parentNotificationMode: 'queue-only',
      },
    });
    const created = await rig.agents.createRoleProfile(
      rig.human(['supervision:watch:start-turn']), role,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const agent = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: created.value.id,
      displayName: 'Drift Builder',
      rootHumanPrincipalId: CHRIS,
    });
    assert.equal(agent.ok, true);
    if (!agent.ok) return;
    const resolved = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agent.value.agent.id,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.value.executionPolicy.commandScopes, [
      'supervision:watch:start-turn',
    ]);
    const reread = await rig.agents.getResolvedLaunchPlan(rig.principal(), resolved.value.id);
    assert.equal(reread.ok, true);
    if (reread.ok) assert.equal(reread.value.supervisionPolicy.activityDrift, 'required');
  });
});

test('a role cannot authorize watcher start-turns without the trusted scope', async () => {
  await withRig(async (rig) => {
    const refused = await rig.agents.createRoleProfile(rig.human(), roleInput({
      supervisionPolicy: {
        activityDrift: 'required',
        requiredWatcherTemplates: [],
        parentNotificationMode: 'queue-only',
      },
    }));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  });
});

test('a role cannot pin a watcher template absent from the Agents catalogue', async () => {
  await withRig(async (rig) => {
    const refused = await rig.agents.createRoleProfile(rig.human(), roleInput({
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [{ id: 'watch-template/missing', version: 1, digest: 'f'.repeat(64) }],
        parentNotificationMode: 'queue-only',
      },
    }));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'WatchRuleInvalid');
  });
});

test('an allowed override is honoured; a forbidden one is refused', async () => {
  await withRig(async (rig) => {
    const { agentId } = await seed(rig);

    const allowed = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      requestedProvider: 'codex',
      requestedModelId: 'sonnet',
      requestedEffort: 'medium',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(allowed.value.provider, 'codex');
      assert.equal(allowed.value.modelId, 'sonnet');
      assert.equal(allowed.value.effort, 'medium');
    }

    // Three separate ways to ask for something the role does not permit.
    const forbidden = [
      { requestedProvider: 'kimi' as const },
      { requestedModelId: 'haiku' },
      { requestedEffort: 'low' },
    ];
    for (const override of forbidden) {
      const refused = await rig.agents.resolveLaunchPlan(rig.human(), {
        agentId: agentId as never,
        configurationMode: 'refresh-role',
        workingDirectory: '/tmp/work',
        supervised: true,
        ...override,
      });
      assert.equal(refused.ok, false, `${JSON.stringify(override)} was allowed`);
      if (!refused.ok) {
        assert.equal(refused.error.code, 'LaunchPlanInvalid');
        assert.equal(refused.error.retryable, false);
      }
    }
  });
});

test('supervised work with a disabled gate is refused before anything is created', async () => {
  await withRig(async (rig) => {
    const { agentId } = await seed(rig, chatRoleInput());

    // The one legal use of a disabled gate: interactive chat, no supervised task.
    const chat = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: false,
    });
    assert.equal(chat.ok, true, 'a chat launch with a disabled gate is legal');

    const supervised = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(supervised.ok, false);
    if (!supervised.ok) assert.equal(supervised.error.code, 'LaunchPlanInvalid');
  });
});

test('supervised work with an empty pinned skill list is refused', async () => {
  await withRig(async (rig) => {
    const { agentId } = await seed(rig, roleInput({ skillRefs: [] }));
    const refused = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(refused.ok, false, 'a supervised launch pinned no skills and was allowed');
    if (!refused.ok) assert.equal(refused.error.code, 'LaunchPlanInvalid');
  });
});

test('editing a role never changes a plan a Run is already pinned to', async () => {
  await withRig(async (rig) => {
    const { roleId, agentId, roleVersion } = await seed(rig);
    const pinned = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) return;

    // Weaken the role: drop a skill and force a cheaper model.
    const weakened = await rig.agents.updateRoleProfile(rig.human(), {
      roleProfileId: roleId,
      expectedRecordVersion: roleVersion,
      replacement: roleInput({
        skillRefs: [{ id: 'tdd', version: 1, digest: 'digest-tdd-v1' }],
        modelPolicy: {
          allowedModelIds: ['sonnet'], defaultModelId: 'sonnet',
          allowNativeChange: false, allowReplacementChange: false,
        },
      }),
    });
    assert.equal(weakened.ok, true);

    const stillPinned = await rig.agents.getLaunchPlan(rig.principal(), pinned.value.id);
    assert.equal(stillPinned.ok, true);
    if (!stillPinned.ok) return;
    assert.equal(stillPinned.value.modelId, 'opus', 'the pinned plan followed the role edit');
    assert.equal(stillPinned.value.skills.length, 2, 'the pinned skill set followed the role edit');
    assert.equal(stillPinned.value.roleProfile.version, roleVersion,
      'the plan must name the role version it actually froze');
  });
});

test('inherit-plan reuses the exact plan; refresh-role builds a new one', async () => {
  await withRig(async (rig) => {
    const { roleId, agentId, roleVersion } = await seed(rig);
    const first = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const inherited = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'inherit-plan',
      inheritedPlanId: first.value.id,
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(inherited.ok, true);
    if (inherited.ok) {
      assert.equal(inherited.value.id, first.value.id, 'inherit-plan must not mint a second plan');
    }

    // A role edit followed by refresh-role DOES move — that is the difference.
    await rig.agents.updateRoleProfile(rig.human(), {
      roleProfileId: roleId,
      expectedRecordVersion: roleVersion,
      replacement: roleInput({
        modelPolicy: {
          allowedModelIds: ['sonnet'], defaultModelId: 'sonnet',
          allowNativeChange: true, allowReplacementChange: true,
        },
      }),
    });
    const refreshed = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) {
      assert.notEqual(refreshed.value.id, first.value.id);
      assert.equal(refreshed.value.modelId, 'sonnet');
    }
  });
});

test('inherit-plan refuses a plan belonging to a different Agent', async () => {
  await withRig(async (rig) => {
    const first = await seed(rig);
    const second = await seed(rig);
    const plan = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: first.agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    const stolen = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: second.agentId as never,
      configurationMode: 'inherit-plan',
      inheritedPlanId: plan.value.id,
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(stolen.ok, false, 'one Agent inherited another Agent\'s pinned plan');
    if (!stolen.ok) assert.equal(stolen.error.code, 'LaunchPlanInvalid');
  });
});

test('a retired role cannot be launched from', async () => {
  await withRig(async (rig) => {
    const { roleId, agentId, roleVersion } = await seed(rig);
    const retired = await rig.agents.updateRoleProfile(rig.human(), {
      roleProfileId: roleId,
      expectedRecordVersion: roleVersion,
      replacement: roleInput({ status: 'retired' }),
    });
    assert.equal(retired.ok, true);

    const refused = await rig.agents.resolveLaunchPlan(rig.human(), {
      agentId: agentId as never,
      configurationMode: 'refresh-role',
      workingDirectory: '/tmp/work',
      supervised: true,
    });
    assert.equal(refused.ok, false, 'a retired role was launched from');
    if (!refused.ok) assert.equal(refused.error.code, 'RoleNotAllowed');
  });
});

test('a role update at a stale version loses rather than overwriting', async () => {
  await withRig(async (rig) => {
    const { roleId, roleVersion } = await seed(rig);
    const first = await rig.agents.updateRoleProfile(rig.human(), {
      roleProfileId: roleId,
      expectedRecordVersion: roleVersion,
      replacement: roleInput({ description: 'first writer' }),
    });
    assert.equal(first.ok, true);

    const stale = await rig.agents.updateRoleProfile(rig.human(), {
      roleProfileId: roleId,
      expectedRecordVersion: roleVersion,
      replacement: roleInput({ description: 'second writer' }),
    });
    assert.equal(stale.ok, false, 'a stale role update overwrote a newer one');
    if (!stale.ok) assert.equal(stale.error.code, 'VersionConflict');
  });
});

test('resolution is deterministic: same inputs, same fingerprint', async () => {
  await withRig(async (rig) => {
    const { agentId } = await seed(rig);
    const request = {
      agentId: agentId as never,
      configurationMode: 'refresh-role' as const,
      workingDirectory: '/tmp/work',
      supervised: true,
    };
    const left = await rig.agents.resolveLaunchPlan(rig.human(), request);
    const right = await rig.agents.resolveLaunchPlan(rig.human(), request);
    assert.equal(left.ok && right.ok, true);
    if (!left.ok || !right.ok) return;
    assert.equal(left.value.resolutionFingerprint, right.value.resolutionFingerprint,
      'B3R-005: the same role and request must resolve to the same plan content');
    assert.notEqual(left.value.id, right.value.id,
      'each resolution is its own immutable record');
  });
});

test('a malformed role is refused with field-level issues', async () => {
  await withRig(async (rig) => {
    const broken = await rig.agents.createRoleProfile(rig.human(), roleInput({
      providerPolicy: { allowed: ['claude'], defaultProvider: 'kimi' },
    }));
    assert.equal(broken.ok, false, 'a default provider outside the allowed set was accepted');
    if (!broken.ok) {
      assert.equal(broken.error.code, 'ValidationFailed');
      assert.equal(Array.isArray((broken.error.details as { issues?: unknown }).issues), true);
    }
  });
});
