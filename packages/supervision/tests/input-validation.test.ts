import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCheckRunDriftInput,
  parseInstallRunWatchersInput,
} from '../contract/index.js';

test('installRunWatchers boundary validates both Run and launch-plan identities', () => {
  const parsed = parseInstallRunWatchersInput({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [
      { id: 'template.drift', version: 1, digest: 'sha256:drift-v1' },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);

  const crossed = parseInstallRunWatchersInput({
    agentRunId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [],
  });
  assert.equal(crossed.ok, false);
});

test('drift-check boundary requires every exact generation/version fence', () => {
  const parsed = parseCheckRunDriftInput({
    watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    expectedActivityGeneration: 7,
    dueDeadlineId: `watchDeadline_${'a'.repeat(52)}`,
    expectedDeadlineRecordVersion: 4,
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
});
