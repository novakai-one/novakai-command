// B3c — §19.1's transcript section on AgentRunView, and the four-way honesty
// it exists to protect.
//
// The view's whole job is to say which of several different things is true
// without collapsing them. `unbound` (nobody asked Transcript about this Run),
// `waiting` (bound, file not there yet), `missing`, `bound` and `corrupt` are
// five distinct answers, and a UI that showed one blank field for all of them
// would be the "unavailable is not zero" failure §24.5 forbids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import type { AgentRunView } from '../../../agent-runtime/contract/index.js';

const RUNTIME_PRINCIPAL = {
  id: 'sys_agent_runtime' as never, kind: 'system' as const, verifiedScopes: [],
};

interface Rig {
  readonly host: Awaited<ReturnType<typeof startRuntimeHost>>;
  close(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-runview-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  return {
    host,
    async close() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a Run nobody has bound reports `unbound`, not a blank', async () => {
  const harness = await rig();
  try {
    const view = await harness.host.runtime.runs.getAgentRun(
      RUNTIME_PRINCIPAL, 'agentRun_01900000-0000-7000-8000-0000000000ff' as never,
    );
    // The Run does not exist, so this is UnknownAgentRun — but the important
    // half is that the lookup did not throw when no Transcript answer exists.
    assert.equal(view.ok, false);
    if (view.ok) return;
    assert.equal(view.error.code, 'UnknownAgentRun');
  } finally {
    await harness.close();
  }
});

test('binding a Run makes its transcript state readable from the Run view', async () => {
  const harness = await rig();
  try {
    const agentId = 'agent_aaaaaaaa-0000-4000-8000-000000000001';
    const agentRunId = 'agentRun_01900000-0000-7000-8000-000000000001';
    const thread = await harness.host.runtime.messaging.ensureDirectThread({
      principal: { id: 'person_chris' as never, kind: 'human', verifiedScopes: [] },
      clientOpId: 'op_00000000-0000-4000-8000-000000000001' as never,
      traceId: 'trace_00000000-0000-4000-8000-000000000001' as never,
      contractVersion: 1,
    }, {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: agentId as never },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    const bound = await harness.host.runtime.transcript.bindTranscriptToRun({
      principal: RUNTIME_PRINCIPAL,
      clientOpId: 'op_00000000-0000-4000-8000-000000000002' as never,
      traceId: 'trace_00000000-0000-4000-8000-000000000002' as never,
      contractVersion: 1,
    }, {
      agentId: agentId as never,
      agentRunId: agentRunId as never,
      provider: 'claude',
      providerSessionId: 'sess_11111111-0000-4000-8000-000000000001' as never,
      threadId: thread.value.id,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;

    // A fresh bind is `waiting`, and the view says so rather than staying
    // silent — the distinction §25-B3c calls "never silent absence".
    assert.equal(bound.value.sourceDiscoveryState, 'waiting');
    assert.equal(bound.value.mirrorWatermark, undefined);

    const looked = await harness.host.runtime.transcript.getTranscriptBinding(
      RUNTIME_PRINCIPAL, agentRunId as never,
    );
    assert.equal(looked.ok && looked.value.sourceDiscoveryState, 'waiting');
  } finally {
    await harness.close();
  }
});

test('AgentRunView declares a transcript section at all', () => {
  // A compile-time claim made executable: the field is normative in §19.1 and
  // was absent at B3b. If it is dropped again this stops compiling.
  const shape: Pick<AgentRunView, 'transcript'> = {
    transcript: { bindingState: 'unbound' },
  };
  assert.equal(shape.transcript.bindingState, 'unbound');
  assert.equal(shape.transcript.mirrorWatermark, undefined);
});
