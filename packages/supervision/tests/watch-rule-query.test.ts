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
  const page = await listWatchRules(store, {
    id: 'person_chris' as never,
    kind: 'human',
    verifiedScopes: [],
  }, { limit: 1 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(parseWatchRulePage(page.value).ok, true);
  assert.equal(page.value.items.length, 1);
  assert.deepEqual(page.value.omissions, [{ reason: 'permission', count: 1 }]);

  const systemPage = await listWatchRules(store, {
    id: 'sys_supervision', kind: 'system', verifiedScopes: [],
  }, { limit: 1 });
  assert.equal(systemPage.ok, true);
  if (!systemPage.ok) return;
  assert.equal(systemPage.value.items.length, 1);
  assert.equal(systemPage.value.nextCursor, rules[0]!.id);
  const resumed = await listWatchRules(store, {
    id: 'sys_supervision', kind: 'system', verifiedScopes: [],
  }, { cursor: systemPage.value.nextCursor, limit: 1 });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.value.items[0]!.id, hidden.id);
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
