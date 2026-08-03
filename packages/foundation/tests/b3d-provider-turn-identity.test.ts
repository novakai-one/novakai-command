import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidId,
  providerTurnBoundaryProfileId,
  providerTurnSubmissionId,
  transcriptTurnCompletionId,
} from '../contract/index.js';

test('provider-turn correlation identities are deterministic and namespace-separated', () => {
  const controller = providerTurnSubmissionId(
    'agentRun_a' as never,
    { kind: 'controller' },
    'effect_same',
  );
  const runtime = providerTurnSubmissionId(
    'agentRun_a' as never,
    { kind: 'runtime-effect', source: 'skills-gate' },
    'effect_same',
  );
  const otherSource = providerTurnSubmissionId(
    'agentRun_a' as never,
    { kind: 'runtime-effect', source: 'watcher-status-request' },
    'effect_same',
  );

  assert.equal(controller, providerTurnSubmissionId(
    'agentRun_a' as never,
    { kind: 'controller' },
    'effect_same',
  ));
  assert.notEqual(controller, runtime);
  assert.notEqual(runtime, otherSource);
  assert.equal(isValidId(controller, 'providerTurnSubmission', 'base32sha256'), true);

  const completion = transcriptTurnCompletionId(
    'transcriptBinding_a' as never,
    'providerTurn_a' as never,
  );
  assert.equal(isValidId(completion, 'transcriptTurnCompletion', 'base32sha256'), true);
  assert.notEqual(completion, controller as string);

  const profile = providerTurnBoundaryProfileId('{"provider":"claude"}');
  assert.equal(isValidId(profile, 'turnBoundaryProfile', 'base32sha256'), true);
});
