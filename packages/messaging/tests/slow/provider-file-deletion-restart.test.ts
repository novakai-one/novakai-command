import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultMessagingRuntime } from '../../contract/compose/ingestion.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';

const AGENT_ID = 'agent_restart-proof';

const directory = (): AgentDirectory => ({
  async get(agentId) {
    return agentId === AGENT_ID
      ? { agentId, provider: 'claude', currentProviderSessionId: null }
      : null;
  },
  async ensureForSession() {
    return { ok: false, code: 'NotExpected', message: 'hook evidence owns assignment' };
  },
  async deliveryReadiness() { return 'idle'; },
  async attachProviderSession() { return { ok: true, state: 'attached' }; },
});

async function seedProviderFile(providerHome: string): Promise<void> {
  const folder = path.join(providerHome, '.claude', 'projects', 'fixture');
  await mkdir(folder, { recursive: true });
  const identity = JSON.stringify({
    kind: 'novakai-agent-identity',
    schemaVersion: 1,
    hookEvent: 'UserPromptSubmit',
    agentId: AGENT_ID,
  });
  const rows = [
    {
      type: 'system', subtype: 'hook_response', sessionId: 'provider-restart-proof',
      message: { role: 'system', content: [{ type: 'hook_result', content: identity }] },
    },
    {
      type: 'user', uuid: 'provider-user-1', sessionId: 'provider-restart-proof',
      message: { role: 'user', content: 'question' },
    },
    {
      type: 'assistant', uuid: 'provider-tool-1', sessionId: 'provider-restart-proof',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file: 'proof.txt' } }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
  ];
  await writeFile(
    path.join(folder, 'session.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

test('provider-file deletion and restart preserve history, Views and rebuilds', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nvk-transcript-restart-'));
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  await seedProviderFile(providerHome);
  const first = await createDefaultMessagingRuntime({
    root, providerHome, agentDirectory: directory(), installIdentityHooks: false,
  });
  const ingested = await first.runtime.ingestNow();
  assert.equal(ingested.kind, 'ok');
  const view = await first.runtime.ensureConversationView({
    conversationId: 'conv_restart-proof',
    participantIds: ['person_chris', AGENT_ID],
    clientOpId: 'proof:view',
    titleOverride: 'Restart proof',
    agentId: AGENT_ID,
    provider: 'claude',
  });
  assert.equal(view.kind, 'ok');
  const linesBefore = await first.runtime.listTranscriptLines();
  const viewsBefore = await first.runtime.listConversationViews();
  const rebuilt = await first.runtime.rebuildProjections();
  const rebuiltAgain = await first.runtime.rebuildProjections();
  assert.deepEqual(rebuiltAgain, rebuilt);
  assert.equal(rebuilt.kind === 'ok' && rebuilt.value.usageRollups[0]?.tokens, 7);
  assert.equal(rebuilt.kind === 'ok' && rebuilt.value.toolCalls[0]?.toolName, 'Read');
  await first.close();

  await rm(providerHome, { recursive: true });
  const second = await createDefaultMessagingRuntime({
    root, providerHome, agentDirectory: directory(), installIdentityHooks: false,
  });
  try {
    assert.deepEqual(await second.runtime.listTranscriptLines(), linesBefore);
    assert.deepEqual(await second.runtime.listConversationViews(), viewsBefore);
    assert.deepEqual(await second.runtime.readProjections(), rebuilt);
    assert.deepEqual(await second.runtime.rebuildProjections(), rebuilt);
  } finally {
    await second.close();
  }
});
