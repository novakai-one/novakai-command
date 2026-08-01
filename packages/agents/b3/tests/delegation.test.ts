// Server-enforced delegation (DEC-B3V4-12, §22, red gate 6).
//
// The claim under test is absolute: no Agent receives authority its issuer did
// not hold. Every case below is written from that sentence — a grant that tries
// to widen, a grant used on something it does not name, a scope that looks
// close enough, and an Agent that outlives the Run its authority came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintAgentRunId,
  type AgentId, type AgentRoleProfileId, type AgentRunId, type AuthorityScope,
} from '@novakai/foundation/contract';
import { SCOPE, HUMAN_SCOPES } from '../core/context.js';
import { createRig, roleInput, CHRIS } from './harness.js';

async function withRig<T>(work: (rig: ReturnType<typeof createRig>) => Promise<T>): Promise<T> {
  const rig = createRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

const scopeNames = HUMAN_SCOPES.map((scope) => String(scope));

interface Team {
  readonly managerRoleId: AgentRoleProfileId;
  readonly builderRoleId: AgentRoleProfileId;
  readonly auditorRoleId: AgentRoleProfileId;
  readonly manager: AgentId;
  readonly builder: AgentId;
  readonly managerRunId: AgentRunId;
  readonly builderRunId: AgentRunId;
}

/**
 * A realistic org: a manager whose role may spawn builders, a builder whose
 * role may spawn auditors, and a live grant for each — exactly the shape the
 * three-generation public proof needs.
 */
async function team(rig: ReturnType<typeof createRig>): Promise<Team> {
  const auditorRole = await rig.agents.createRoleProfile(rig.human(), roleInput({ name: 'auditor' }));
  assert.equal(auditorRole.ok, true);
  if (!auditorRole.ok) throw new Error('unreachable');

  const builderRole = await rig.agents.createRoleProfile(rig.human(), roleInput({
    name: 'builder',
    spawnPolicy: { allowedChildRoleIds: [auditorRole.value.id], requireManagedSpawn: true },
  }));
  assert.equal(builderRole.ok, true);
  if (!builderRole.ok) throw new Error('unreachable');

  const managerRole = await rig.agents.createRoleProfile(rig.human(), roleInput({
    name: 'manager',
    spawnPolicy: { allowedChildRoleIds: [builderRole.value.id], requireManagedSpawn: true },
  }));
  assert.equal(managerRole.ok, true);
  if (!managerRole.ok) throw new Error('unreachable');

  const managerRunId = mintAgentRunId();
  const builderRunId = mintAgentRunId();

  const manager = await rig.agents.createAgentFromRole(rig.human(), {
    roleProfileId: managerRole.value.id, displayName: 'Manager', rootHumanPrincipalId: CHRIS,
  });
  assert.equal(manager.ok, true);
  if (!manager.ok) throw new Error('unreachable');

  const builder = await rig.agents.createAgentFromRole(rig.human(), {
    roleProfileId: builderRole.value.id, displayName: 'Builder', rootHumanPrincipalId: CHRIS,
    parentAgentId: manager.value.agent.id, creatingRunId: managerRunId,
  });
  assert.equal(builder.ok, true);
  if (!builder.ok) throw new Error('unreachable');

  return {
    managerRoleId: managerRole.value.id,
    builderRoleId: builderRole.value.id,
    auditorRoleId: auditorRole.value.id,
    manager: manager.value.agent.id,
    builder: builder.value.agent.id,
    managerRunId,
    builderRunId,
  };
}

/** Issue a grant as the human, exactly as the Runtime does at spawn time. */
async function grant(
  rig: ReturnType<typeof createRig>,
  input: {
    runId: AgentRunId; subject: AgentId; targets: readonly AgentId[];
    scopes: readonly string[]; childRoles: readonly AgentRoleProfileId[];
  },
): ReturnType<ReturnType<typeof createRig>['agents']['issueDelegationGrant']> {
  return rig.agents.issueDelegationGrant(rig.human(scopeNames), {
    issuerAgentRunId: input.runId,
    subjectAgentId: input.subject,
    targetAgentIds: input.targets,
    requestedScopes: input.scopes as readonly AuthorityScope[],
    requestedChildRoleIds: input.childRoles,
  });
}

test('a grant cannot carry a scope its issuer does not hold', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    // The issuing human holds everything EXCEPT stop-tree in this call.
    const narrowed = scopeNames.filter((scope) => scope !== String(SCOPE.stopTree));
    const escalating = await rig.agents.issueDelegationGrant(rig.human(narrowed), {
      issuerAgentRunId: org.managerRunId,
      subjectAgentId: org.manager,
      targetAgentIds: [org.builder],
      requestedScopes: [SCOPE.stopOne, SCOPE.stopTree],
      requestedChildRoleIds: [],
    });
    assert.equal(escalating.ok, false, 'a grant carried authority its issuer lacked');
    if (!escalating.ok) {
      assert.equal(escalating.error.code, 'AuthorityEscalation');
      const details = escalating.error.details as { allowedScopes?: readonly string[] };
      assert.equal(details.allowedScopes?.includes(String(SCOPE.stopTree)), false);
    }
  });
});

test('a grant cannot name a child role the subject role forbids', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    // The manager role permits builders, not auditors.
    const overreaching = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [org.builder],
      scopes: [String(SCOPE.spawn)], childRoles: [org.auditorRoleId],
    });
    assert.equal(overreaching.ok, false, 'a grant named a child role the role policy forbids');
    if (!overreaching.ok) assert.equal(overreaching.error.code, 'RoleNotAllowed');
  });
});

test('an Agent with no grant cannot spawn at all', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    const refused = await rig.agents.authoriseSpawn(
      rig.agentRun(org.managerRunId).principal,
      { roleProfileId: org.builderRoleId, callerAgentId: org.manager, callerAgentRunId: org.managerRunId },
    );
    assert.equal(refused.ok, false, 'an ungranted Agent spawned');
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  });
});

test('a granted Agent spawns the permitted role and only that role', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    const issued = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [],
      scopes: [String(SCOPE.spawn)], childRoles: [org.builderRoleId],
    });
    assert.equal(issued.ok, true);

    const permitted = await rig.agents.authoriseSpawn(
      rig.agentRun(org.managerRunId).principal,
      { roleProfileId: org.builderRoleId, callerAgentId: org.manager, callerAgentRunId: org.managerRunId },
    );
    assert.equal(permitted.ok, true, 'a granted spawn was refused');
    if (permitted.ok) {
      // Parenthood and root come from the AUTHENTICATED caller, never a payload.
      assert.equal(permitted.value.parentAgentId, org.manager);
      assert.equal(permitted.value.rootHumanPrincipalId, CHRIS);
      assert.equal(permitted.value.launchSurface, 'agent');
    }

    const forbidden = await rig.agents.authoriseSpawn(
      rig.agentRun(org.managerRunId).principal,
      { roleProfileId: org.auditorRoleId, callerAgentId: org.manager, callerAgentRunId: org.managerRunId },
    );
    assert.equal(forbidden.ok, false, 'a granted Agent spawned a role outside its grant');
    if (!forbidden.ok) assert.equal(forbidden.error.code, 'RoleNotAllowed');
  });
});

test('holding stop-one never implies holding stop-tree', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    const issued = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [org.builder],
      scopes: [String(SCOPE.stopOne)], childRoles: [],
    });
    assert.equal(issued.ok, true);
    const principal = rig.agentRun(org.managerRunId).principal;

    const stopOne = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: org.builder, operation: 'stop-one',
    });
    assert.equal(stopOne.ok, true, 'stop-one was refused to a holder of stop-one');

    const stopTree = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: org.builder, operation: 'stop-tree',
    });
    assert.equal(stopTree.ok, false, '§22: stop-tree is a SEPARATE scope');
    if (!stopTree.ok) {
      assert.equal(stopTree.error.code, 'PermissionDenied');
      assert.equal((stopTree.error.details as { requiredScope?: string }).requiredScope,
        String(SCOPE.stopTree));
    }
  });
});

test('a grant reaches its named target\'s descendants, and nothing else', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    // The builder spawns an auditor, so the manager's grant over the builder
    // must also reach the auditor — and must not reach an unrelated Agent.
    const auditor = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: org.auditorRoleId, displayName: 'Auditor', rootHumanPrincipalId: CHRIS,
      parentAgentId: org.builder, creatingRunId: org.builderRunId,
    });
    assert.equal(auditor.ok, true);
    const stranger = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: org.auditorRoleId, displayName: 'Stranger', rootHumanPrincipalId: CHRIS,
    });
    assert.equal(stranger.ok, true);
    if (!auditor.ok || !stranger.ok) return;

    const issued = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [org.builder],
      scopes: [String(SCOPE.interrupt)], childRoles: [],
    });
    assert.equal(issued.ok, true);
    const principal = rig.agentRun(org.managerRunId).principal;

    const descendant = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: auditor.value.agent.id, operation: 'interrupt',
    });
    assert.equal(descendant.ok, true, 'a grant did not reach its target\'s descendant');

    const unrelated = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: stranger.value.agent.id, operation: 'interrupt',
    });
    assert.equal(unrelated.ok, false, 'a grant reached an Agent outside its subtree');
    if (!unrelated.ok) assert.equal(unrelated.error.code, 'PermissionDenied');
  });
});

test('a grant dies with the Run it came from', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    const issued = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [org.builder],
      scopes: [String(SCOPE.interrupt)], childRoles: [],
    });
    assert.equal(issued.ok, true);
    const principal = rig.agentRun(org.managerRunId).principal;

    const before = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: org.builder, operation: 'interrupt',
    });
    assert.equal(before.ok, true);

    const expired = await rig.agents.expireGrantsOfRun(rig.system(), org.managerRunId);
    assert.equal(expired.ok, true);
    if (expired.ok) assert.equal(expired.value.expired.length, 1);

    const after = await rig.agents.authoriseRunOperation(principal, {
      targetAgentId: org.builder, operation: 'interrupt',
    });
    assert.equal(after.ok, false, 'an Agent outlived the authority its Run carried');
  });
});

test('a human without the scope is refused, exactly like an Agent', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    // Red gate 23: the human path is not a bypass — it is the same check.
    const refused = await rig.agents.authoriseSpawn(
      rig.human([]).principal, { roleProfileId: org.builderRoleId },
    );
    assert.equal(refused.ok, false, 'an unscoped human spawned');
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');

    const allowed = await rig.agents.authoriseSpawn(
      rig.human(scopeNames).principal, { roleProfileId: org.builderRoleId },
    );
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(allowed.value.parentAgentId, undefined, 'a human spawn made a child, not a root');
    }
  });
});

test('a role depth limit stops the family growing past it', async () => {
  await withRig(async (rig) => {
    const auditorRole = await rig.agents.createRoleProfile(rig.human(), roleInput({ name: 'auditor' }));
    assert.equal(auditorRole.ok, true);
    if (!auditorRole.ok) return;
    // A builder that may spawn auditors, but only one generation below the root.
    const builderRole = await rig.agents.createRoleProfile(rig.human(), roleInput({
      name: 'builder',
      spawnPolicy: {
        allowedChildRoleIds: [auditorRole.value.id], maxDepth: 1, requireManagedSpawn: true,
      },
    }));
    assert.equal(builderRole.ok, true);
    if (!builderRole.ok) return;

    const root = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: builderRole.value.id, displayName: 'Root', rootHumanPrincipalId: CHRIS,
    });
    assert.equal(root.ok, true);
    if (!root.ok) return;
    const rootRunId = mintAgentRunId();
    const child = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: builderRole.value.id, displayName: 'Child', rootHumanPrincipalId: CHRIS,
      parentAgentId: root.value.agent.id, creatingRunId: rootRunId,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;

    const childRunId = mintAgentRunId();
    const issued = await grant(rig, {
      runId: childRunId, subject: child.value.agent.id, targets: [],
      scopes: [String(SCOPE.spawn)], childRoles: [auditorRole.value.id],
    });
    assert.equal(issued.ok, true);

    // The child sits at depth 1; a grandchild would be depth 2, past maxDepth.
    const tooDeep = await rig.agents.authoriseSpawn(rig.agentRun(childRunId).principal, {
      roleProfileId: auditorRole.value.id,
      callerAgentId: child.value.agent.id,
      callerAgentRunId: childRunId,
    });
    assert.equal(tooDeep.ok, false, 'the family grew past its role depth limit');
    if (!tooDeep.ok) assert.equal(tooDeep.error.code, 'RoleNotAllowed');
  });
});

test('an Agent-run grant can only be narrowed by the next generation', async () => {
  await withRig(async (rig) => {
    const org = await team(rig);
    // The manager holds interrupt only.
    const managerGrant = await grant(rig, {
      runId: org.managerRunId, subject: org.manager, targets: [org.builder],
      scopes: [String(SCOPE.interrupt)], childRoles: [],
    });
    assert.equal(managerGrant.ok, true);

    // It now tries to hand its child BOTH interrupt and stop-one.
    const widening = await rig.agents.issueDelegationGrant(
      rig.agentRun(org.managerRunId), {
        issuerAgentRunId: org.builderRunId,
        subjectAgentId: org.builder,
        targetAgentIds: [],
        requestedScopes: [SCOPE.interrupt, SCOPE.stopOne],
        requestedChildRoleIds: [],
      },
    );
    assert.equal(widening.ok, false, 'a generation handed on authority it never held');
    if (!widening.ok) assert.equal(widening.error.code, 'AuthorityEscalation');

    // Narrowing to what it does hold is fine.
    const narrowed = await rig.agents.issueDelegationGrant(
      rig.agentRun(org.managerRunId), {
        issuerAgentRunId: org.builderRunId,
        subjectAgentId: org.builder,
        targetAgentIds: [],
        requestedScopes: [SCOPE.interrupt],
        requestedChildRoleIds: [],
      },
    );
    assert.equal(narrowed.ok, true, 'narrowing a grant was refused');
  });
});
