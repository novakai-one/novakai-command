// §4.1 at the boundaries B3c added — "an id of the wrong KIND is rejected by
// prefix", which the exam already proves for `b3.agent.*` (A4) and which the
// `b3.messaging.*` validators never did.
//
// `readSendAgentMessageInput`, `readParticipant`,
// `readOpenConversationInput` and `readListAgentCommunicationsInput` each
// accepted `typeof x === 'string'` and cast. So an AgentRoleProfileId passed
// where an AgentId belongs reached the capability, which resolved it against
// nothing and answered `UnknownAgent` — a plausible-looking answer to a
// question that was never legal, and one that says the Agent is missing rather
// than that the caller sent the wrong kind of id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';

/** A real id of the WRONG kind — §4.1-legal, just not the one asked for. */
const ROLE_ID = 'agentRole_019fc000-0000-7000-8000-000000000001';
const RUN_ID = 'agentRun_019fc000-0000-7000-8000-000000000002';
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';

test('every b3.messaging boundary rejects an id of the wrong kind by prefix', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-prefixes-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const cases: readonly { readonly method: string; readonly payload: unknown }[] = [
      {
        method: 'b3.messaging.sendAgent',
        payload: { target: { kind: 'agent', agentId: ROLE_ID }, text: 'x' },
      },
      {
        // An AgentId where an AgentRunId belongs: the mirror image, and the one
        // that would otherwise be answered `UnknownAgentRun`.
        method: 'b3.messaging.sendAgent',
        payload: { target: { kind: 'exact-run', agentRunId: AGENT_ID }, text: 'x' },
      },
      {
        method: 'b3.messaging.ensureDirectThread',
        payload: {
          between: [
            { kind: 'human', personId: 'person_chris' },
            { kind: 'agent', agentId: ROLE_ID },
          ],
        },
      },
      {
        method: 'b3.messaging.ensureGroupThread',
        payload: {
          participants: [
            { kind: 'agent', agentId: AGENT_ID },
            { kind: 'agent', agentId: RUN_ID },
          ],
        },
      },
      {
        method: 'b3.messaging.listAgentCommunications',
        payload: { agentIds: [ROLE_ID] },
      },
      {
        method: 'b3.messaging.listAgentCommunications',
        payload: { agentIds: [AGENT_ID], runIds: [ROLE_ID] },
      },
      {
        method: 'b3.messaging.openConversation',
        payload: {
          threadId: 'thread_anything',
          membership: { kind: 'direct', agentId: ROLE_ID },
        },
      },
      {
        method: 'b3.messaging.openConversation',
        payload: {
          threadId: 'thread_anything',
          membership: { kind: 'group', agentIds: [AGENT_ID, RUN_ID] },
        },
      },
    ];

    const accepted: string[] = [];
    const miscoded: string[] = [];
    for (const [index, probe] of cases.entries()) {
      const answered = await chris.call(probe.method, probe.payload);
      if (answered.ok) {
        accepted.push(`${probe.method}#${String(index)}`);
        continue;
      }
      // §4.1 wrong-kind is a boundary refusal, not a lookup miss. `UnknownAgent`
      // says "that Agent does not exist"; the truth is "that is not an AgentId".
      if (answered.error.code !== 'ValidationFailed') {
        miscoded.push(`${probe.method}#${String(index)} → ${answered.error.code}`);
      }
    }

    assert.deepEqual(accepted, [],
      `an id of the wrong kind was accepted at: ${accepted.join(', ')}`);
    assert.deepEqual(miscoded, [],
      `a wrong-kind id was refused as something other than ValidationFailed: ${miscoded.join(', ')}`);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
