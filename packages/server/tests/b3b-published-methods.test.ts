// Every `b3.*` method §16.2 publishes for Runtime and Agent exists, under the
// name the spec gives it (hold-out H3).
//
// Two of the three were naming drift — `b3.agent.controls` / `b3.agent.control`
// do the work well, under names §16.2 does not use — and a second host written
// from the spec cannot call a method by a name only the implementation knows.
// The third, `subscribeEvents`, has no alias at all: there is no event
// subscription on the public socket, which blocks §24.4's second-host proof as
// well as B3b's observability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { buildB3AgentMethods } from '../core/b3/agent-methods.js';

/** The §16.2 names, as written in the spec. */
const PUBLISHED = [
  'b3.agent.spawn', 'b3.agent.continue', 'b3.agent.adopt',
  'b3.agent.interrupt', 'b3.agent.stop', 'b3.agent.prepareStopTree', 'b3.agent.stopTree',
  'b3.agent.getRun', 'b3.agent.listRuns', 'b3.agent.getTree',
  'b3.agent.getControls', 'b3.agent.applyControl',
  'b3.agent.getOperation', 'b3.agent.listOperations',
  'b3.agent.createRole', 'b3.agent.updateRole',
  'b3.agent.subscribeEvents',
] as const;

test('every method §16.2 publishes is on the table, by its published name', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-published-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const table = buildB3AgentMethods({
      runtime: host.runtime,
      principalFor: () => ({ id: 'person_chris' as never, kind: 'human', verifiedScopes: [] }),
      contextFor: (principal, _session, clientOpId) => ({
        principal, clientOpId, traceId: 'trace_x' as never, contractVersion: 1,
      }),
    });
    const missing = PUBLISHED.filter((name) => !(name in table));
    assert.deepEqual(missing, [], 'methods §16.2 publishes are not on the wire');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
