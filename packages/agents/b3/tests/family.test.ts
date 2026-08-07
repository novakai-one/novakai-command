// The Agent family (DEC-B3V4-06, §13.7, red gates 7–9).
//
// Written from the clauses, not from the implementation: parentage is
// immutable and acyclic, an edge is deterministic, and the tree is queryable in
// both directions to a stated depth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintAgentRunId, type AgentId, type AgentRunId } from '@novakai/foundation/contract';
import { createRig, roleInput, CHRIS } from './harness.js';

async function withRig<T>(work: (rig: ReturnType<typeof createRig>) => Promise<T>): Promise<T> {
  const rig = createRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

interface Family {
  readonly manager: AgentId;
  readonly builder: AgentId;
  readonly auditor: AgentId;
  readonly runId: AgentRunId;
}

/** Manager → Builder → Auditor: the three generations B3b must prove. */
async function threeGenerations(rig: ReturnType<typeof createRig>): Promise<Family> {
  const role = await rig.agents.createRoleProfile(rig.human(), roleInput());
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('unreachable');
  const runId = mintAgentRunId();

  const make = async (displayName: string, parentAgentId?: AgentId): Promise<AgentId> => {
    const created = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: role.value.id,
      displayName,
      rootHumanPrincipalId: CHRIS,
      ...(parentAgentId === undefined ? {} : { parentAgentId, creatingRunId: runId }),
    });
    assert.equal(created.ok, true, `${displayName} was not created`);
    if (!created.ok) throw new Error('unreachable');
    return created.value.agent.id;
  };

  const manager = await make('Manager');
  const builder = await make('Builder', manager);
  const auditor = await make('Auditor', builder);
  return { manager, builder, auditor, runId };
}

test('three generations form a tree, and each child records its own edge', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const children = await rig.agents.listChildren(rig.principal(), family.manager);
    assert.equal(children.ok, true);
    if (children.ok) {
      assert.deepEqual(children.value.map((edge) => edge.childAgentId), [family.builder]);
      assert.equal(children.value[0]?.createdFromRunId, family.runId,
        'an edge must record which Run created it');
    }

    const descendants = await rig.agents.getAgentTree(rig.principal(), {
      rootAgentId: family.manager, direction: 'descendants', maxDepth: 8,
    });
    assert.equal(descendants.ok, true);
    if (descendants.ok) {
      const byDepth = new Map(descendants.value.items.map((node) => [node.agent.id, node.depth]));
      assert.equal(byDepth.get(family.manager), 0);
      assert.equal(byDepth.get(family.builder), 1);
      assert.equal(byDepth.get(family.auditor), 2, 'the grandchild must be two generations down');
    }

    const ancestors = await rig.agents.getAgentTree(rig.principal(), {
      rootAgentId: family.auditor, direction: 'ancestors', maxDepth: 8,
    });
    assert.equal(ancestors.ok, true);
    if (ancestors.ok) {
      const seen = ancestors.value.items.map((node) => node.agent.id);
      assert.equal(seen.includes(family.builder), true, 'the parent is missing from the ancestors');
      assert.equal(seen.includes(family.manager), true, 'the grandparent is missing from the ancestors');
    }
  });
});

test('maxDepth bounds the answer instead of returning the whole tree', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const shallow = await rig.agents.getAgentTree(rig.principal(), {
      rootAgentId: family.manager, direction: 'descendants', maxDepth: 1,
    });
    assert.equal(shallow.ok, true);
    if (!shallow.ok) return;
    const seen = shallow.value.items.map((node) => node.agent.id);
    assert.equal(seen.includes(family.builder), true);
    assert.equal(seen.includes(family.auditor), false, 'maxDepth 1 returned a grandchild');
  });
});

test('recording the same edge twice is one edge, not two', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const again = await rig.agents.recordRelationship(rig.human(), {
      rootHumanPrincipalId: CHRIS,
      parentAgentId: family.manager,
      childAgentId: family.builder,
      createdFromRunId: mintAgentRunId(),
    });
    assert.equal(again.ok, true, 'a repeated edge must be idempotent, not an error');
    const children = await rig.agents.listChildren(rig.principal(), family.manager);
    assert.equal(children.ok, true);
    if (children.ok) assert.equal(children.value.length, 1, 'the same edge was recorded twice');
    // Idempotent means the ORIGINAL edge survives — the second call must not
    // rewrite which Run created it, because that is history (red gate 9).
    if (again.ok) assert.equal(again.value.createdFromRunId, family.runId);
  });
});

test('an edge that would make an Agent its own ancestor is refused', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    // Grandchild adopting the grandparent as its child closes the loop.
    const cycle = await rig.agents.recordRelationship(rig.human(), {
      rootHumanPrincipalId: CHRIS,
      parentAgentId: family.auditor,
      childAgentId: family.manager,
      createdFromRunId: mintAgentRunId(),
    });
    assert.equal(cycle.ok, false, 'a parent/child cycle was recorded (red gate 7)');
    if (!cycle.ok) assert.equal(cycle.error.code, 'RelationshipCycle');

    const direct = await rig.agents.recordRelationship(rig.human(), {
      rootHumanPrincipalId: CHRIS,
      parentAgentId: family.builder,
      childAgentId: family.builder,
      createdFromRunId: mintAgentRunId(),
    });
    assert.equal(direct.ok, false, 'an Agent became its own parent');
    if (!direct.ok) assert.equal(direct.error.code, 'RelationshipCycle');
  });
});

test('an Agent created without a parent is a root and has no edge', async () => {
  await withRig(async (rig) => {
    const role = await rig.agents.createRoleProfile(rig.human(), roleInput());
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const created = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: role.value.id, displayName: 'Root', rootHumanPrincipalId: CHRIS,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.relationship, undefined, 'a root Agent was given a family edge');
    assert.equal(created.value.agent.rootHumanPrincipalId, CHRIS);
  });
});

test('an Agent carries its role and stays readable by the pre-B3 registry', async () => {
  await withRig(async (rig) => {
    const role = await rig.agents.createRoleProfile(rig.human(), roleInput());
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const created = await rig.agents.createAgentFromRole(rig.human(), {
      roleProfileId: role.value.id, displayName: 'Builder One', rootHumanPrincipalId: CHRIS,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.agent.roleProfileId, role.value.id);

    // Red gate 25: Build 3 introduced no second Agent registry, so the stored
    // line must still satisfy the shape the existing registry parses.
    const stored = created.value.agent as unknown as Record<string, unknown>;
    assert.equal(typeof stored['provider'], 'string', 'the pre-B3 registry needs `provider`');
    assert.equal(typeof stored['model'], 'string', 'the pre-B3 registry needs `model`');
    assert.equal(Array.isArray(stored['skills']), true);
  });
});

test('a caller cannot forge createdBy — Foundation stamps the real principal', async () => {
  await withRig(async (rig) => {
    const role = await rig.agents.createRoleProfile(rig.human(), {
      ...roleInput(),
      // A hostile extra field, exactly as a socket caller might send it.
      ...({ createdBy: 'person_someone_else' } as unknown as Record<string, never>),
    });
    assert.equal(role.ok, true);
    if (role.ok) {
      assert.equal(role.value.createdBy, CHRIS,
        'a request body set createdBy (red gate 5)');
    }
  });
});
