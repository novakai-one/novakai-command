import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWatchRuleFilter,
  parseWatchRulePage,
  type SupervisionQueries,
  type WatchRuleFilter,
} from '../contract/index.js';
import { installedWatchRules } from './fixtures.js';

const RUN_ID = 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab';

test('listWatchRules is a bounded visibility-aware frozen query', async () => {
  const parsed = parseWatchRuleFilter({
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    status: ['active', 'paused'],
    cursor: 'cursor_watch-rules-2',
    limit: 20,
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  if (!parsed.ok) return;

  const query: Pick<SupervisionQueries, 'listWatchRules'> = {
    listWatchRules: async (_principal, filter: WatchRuleFilter) => ({
      ok: true,
      value: {
        items: installedWatchRules({
          agentRunId: RUN_ID as never,
          launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
          requiredTemplateRefs: [],
          recipient: { kind: 'human', principalId: 'person_chris' as never },
          activityGeneration: 1 as never,
        }).filter((rule) => filter.status?.includes(rule.status) ?? true),
        omissions: [],
      },
    }),
  };
  const page = await query.listWatchRules({
    id: 'person_chris' as never,
    kind: 'human',
    verifiedScopes: [],
  }, parsed.value);
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(parseWatchRulePage(page.value).ok, true);
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
