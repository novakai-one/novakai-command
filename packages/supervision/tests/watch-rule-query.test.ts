import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWatchRuleFilter,
  parseWatchRulePage,
} from '../contract/index.js';
import { listWatchRules, type SupervisionStore } from '../core/index.js';
import { installedWatchRules } from './fixtures.js';

const RUN_ID = 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab';

test('listWatchRules is a bounded visibility-aware frozen query', async () => {
  const rules = installedWatchRules({
    agentRunId: RUN_ID as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    activityGeneration: 1 as never,
  });
  const hidden = {
    ...rules[1]!,
    recipient: { kind: 'human' as const, principalId: 'person_someone-else' as never },
  };
  const store = {
    list: async () => ({ ok: true as const, value: [rules[0]!, hidden] }),
  } as unknown as SupervisionStore;
  const access = { agentIdFor: async () => ({ ok: true as const, value: null }) };
  const page = await listWatchRules(store, access, {
    id: 'person_chris' as never,
    kind: 'human',
    verifiedScopes: [],
  }, { limit: 1 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(parseWatchRulePage(page.value).ok, true);
  assert.equal(page.value.items.length, 1);
  assert.deepEqual(page.value.omissions, [{ reason: 'permission', count: 1 }]);

  const systemPage = await listWatchRules(store, access, {
    id: 'sys_supervision', kind: 'system', verifiedScopes: [],
  }, { limit: 1 });
  assert.equal(systemPage.ok, true);
  if (!systemPage.ok) return;
  assert.equal(systemPage.value.items.length, 1);
  assert.match(String(systemPage.value.nextCursor), /^watchRules\./);
  const resumed = await listWatchRules(store, access, {
    id: 'sys_supervision', kind: 'system', verifiedScopes: [],
  }, {
    ...(systemPage.value.nextCursor === undefined
      ? {} : { cursor: systemPage.value.nextCursor }),
    limit: 1,
  });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.value.items[0]!.id, hidden.id);

  const changedFilter = await listWatchRules(store, access, {
    id: 'sys_supervision', kind: 'system', verifiedScopes: [],
  }, {
    ...(systemPage.value.nextCursor === undefined
      ? {} : { cursor: systemPage.value.nextCursor }),
    status: ['paused'],
    limit: 1,
  });
  assert.equal(changedFilter.ok, true, 'a filter change invalidated an opaque keyset cursor');
});

test('a parent Run can read a child watcher addressed to its stable Agent', async () => {
  const [base] = installedWatchRules({
    agentRunId: RUN_ID as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    activityGeneration: 1 as never,
  });
  const parentAgentId = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
  const rule = { ...base!, recipient: { kind: 'agent' as const, agentId: parentAgentId } };
  const store = {
    list: async () => ({ ok: true as const, value: [rule] }),
  } as unknown as SupervisionStore;
  const page = await listWatchRules(store, {
    agentIdFor: async () => ({ ok: true as const, value: parentAgentId }),
  }, {
    id: 'agentRunPrincipal_parent' as never,
    kind: 'agent-run',
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ac' as never,
    verifiedScopes: [],
  }, { limit: 10 });
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.value.items[0]!.id, rule.id);
});

test('WatchRule filter and page reject unbounded or malformed wire shapes', () => {
  assert.equal(parseWatchRuleFilter({ limit: 0 }).ok, false);
  assert.equal(parseWatchRuleFilter({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_wrong' },
    status: ['deleted'],
    cursor: 'not a cursor',
    limit: 10,
  }).ok, false);
  assert.equal(parseWatchRulePage({
    items: [],
    omissions: [{ reason: 'hidden', count: 1 }],
  }).ok, false);
});
