import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MessagingError,
} from '@novakai/messaging/dist/public/index.js';
import { composeSpine } from '../contract/index.js';

interface JournalLine {
  envelope: {
    id: string;
  };
  payload: {
    state: string;
    step: number;
  };
}

function readJournal(root: string): JournalLine[] {
  const journalPath = path.join(root, 'stores', 'spineSteps.jsonl');
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalLine);
}

const scenarios = [
  {
    point: 'spine.journal.accepted.before',
    failedEffect: null,
    expectedFacts: [],
    messageCalls: 0,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.accepted.after',
    failedEffect: null,
    expectedFacts: ['accepted:0'],
    messageCalls: 0,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step1.running.before',
    failedEffect: null,
    expectedFacts: ['accepted:0'],
    messageCalls: 0,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step1.running.after',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1'],
    messageCalls: 0,
    attachCalls: 0,
  },
  {
    point: 'spine.effect.step1.before',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1'],
    messageCalls: 0,
    attachCalls: 0,
  },
  {
    point: 'spine.effect.step1.after',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step1.done.before',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step1.done.after',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1', 'done:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step2.running.before',
    failedEffect: null,
    expectedFacts: ['accepted:0', 'running:1', 'done:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step2.running.after',
    failedEffect: null,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
    ],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.effect.step2.before',
    failedEffect: null,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
    ],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.effect.step2.after',
    failedEffect: null,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
    ],
    messageCalls: 1,
    attachCalls: 1,
  },
  {
    point: 'spine.journal.step2.done.before',
    failedEffect: null,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
    ],
    messageCalls: 1,
    attachCalls: 1,
  },
  {
    point: 'spine.journal.step2.done.after',
    failedEffect: null,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
      'done:2',
    ],
    messageCalls: 1,
    attachCalls: 1,
  },
  {
    point: 'spine.journal.step1.failed.before',
    failedEffect: 1,
    expectedFacts: ['accepted:0', 'running:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step1.failed.after',
    failedEffect: 1,
    expectedFacts: ['accepted:0', 'running:1', 'failed:1'],
    messageCalls: 1,
    attachCalls: 0,
  },
  {
    point: 'spine.journal.step2.failed.before',
    failedEffect: 2,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
    ],
    messageCalls: 1,
    attachCalls: 1,
  },
  {
    point: 'spine.journal.step2.failed.after',
    failedEffect: 2,
    expectedFacts: [
      'accepted:0',
      'running:1',
      'done:1',
      'running:2',
      'failed:2',
    ],
    messageCalls: 1,
    attachCalls: 1,
  },
] as const;

test('NVK_FAILPOINT names deterministically cover every workflow journal and effect boundary', async () => {
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    for (const scenario of scenarios) {
      const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-failpoint-'));
      const root = path.join(workspace, '.novakai');
      let messageCalls = 0;
      let attachCalls = 0;
      try {
        process.env.NVK_FAILPOINT = scenario.point;
        const spine = composeSpine({
          root,
          principal: 'sys_spine',
          messaging: {
            async getDelivery(input) {
              messageCalls += 1;
              if (scenario.failedEffect === 1) {
                return {
                  kind: 'error',
                  error: new MessagingError('UnknownMessage', {
                    fields: {
                      messageId: (input as { messageId: string }).messageId,
                    },
                  }),
                };
              }
              return { kind: 'ok', value: { deliveries: [] } };
            },
          },
          artifacts: {
            async getArtifactMeta() {
              return assert.fail('artifact dependency must not be called');
            },
          },
          projects: {
            async attach(projectId, input) {
              attachCalls += 1;
              if (scenario.failedEffect === 2) {
                return {
                  ok: false,
                  error: {
                    code: 'ProjectNotFound',
                    message: 'injected missing Project',
                    details: { projectId },
                    retryable: false,
                  },
                } as never;
              }
              return {
                ok: true,
                value: {
                  kind: 'projectItem',
                  id: 'projectItem_failpoint',
                  schemaVersion: 1,
                  createdAt: new Date().toISOString(),
                  permissionLevel: 'team',
                  createdBy: 'sys_spine',
                  projectId,
                  itemRef: input.itemRef,
                  addedBy: 'sys_spine',
                  addedVia: 'spine',
                },
              };
            },
          },
        });

        const result = await spine.operations.addMessageToProject({
          messageId: 'message_failpoint' as never,
          projectId: 'proj_failpoint' as never,
        }, `op_${scenario.point}` as never);

        assert.equal(result.ok, false, scenario.point);
        assert.equal(
          result.ok ? null : result.error.code,
          'SpineFailpoint',
          scenario.point,
        );
        assert.equal(
          result.ok || result.error.code !== 'SpineFailpoint'
            ? null
            : result.error.details.point,
          scenario.point,
          scenario.point,
        );
        assert.deepEqual(
          readJournal(root).map(
            ({ payload }) => `${payload.state}:${payload.step}`,
          ),
          scenario.expectedFacts,
          scenario.point,
        );
        assert.equal(messageCalls, scenario.messageCalls, scenario.point);
        assert.equal(attachCalls, scenario.attachCalls, scenario.point);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
  }
});
