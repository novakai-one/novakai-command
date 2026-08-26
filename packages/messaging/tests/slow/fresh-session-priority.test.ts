import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDefaultMessagingRuntime,
  type AgentDirectory,
} from '../../contract/index.js';

test('fresh hooked session bypasses machine-wide historical discovery backlog', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nvk-fresh-session-'));
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const historical = path.join(providerHome, '.claude', 'projects', 'history');
  await mkdir(historical, { recursive: true });
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  for (let index = 0; index < 50; index += 1) {
    const file = path.join(historical, `${String(index).padStart(3, '0')}.jsonl`);
    await writeFile(file, `${JSON.stringify({
      type: 'assistant',
      sessionId: `historical-${index}`,
      message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    })}\n`);
    await utimes(file, oldTime, oldTime);
  }

  const agentId = 'agent_fresh-priority';
  const directory: AgentDirectory = {
    async get(id) {
      return id === agentId
        ? { agentId, provider: 'kimi', currentProviderSessionId: null }
        : null;
    },
    async ensureForSession() {
      return { ok: false, code: 'NotExpected', message: 'hook session is not adopted' };
    },
    async deliveryReadiness() { return 'idle'; },
    async attachProviderSession() { return { ok: true, state: 'attached' }; },
  };
  const composed = await createDefaultMessagingRuntime({
    root,
    providerHome,
    agentDirectory: directory,
    installIdentityHooks: false,
  });
  try {
    const sessionDir = path.join(
      providerHome,
      '.kimi-code',
      'sessions',
      'wd_fixture',
      'session_628269c7-9bc3-423f-a236-0d5ecab85c64',
      'agents',
      'main',
    );
    await mkdir(sessionDir, { recursive: true });
    const marker = {
      kind: 'novakai-agent-identity', schemaVersion: 1,
      hookEvent: 'UserPromptSubmit', agentId,
    };
    await writeFile(path.join(sessionDir, 'wire.jsonl'), [
      JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: `<hook_result hook_event="UserPromptSubmit">NOVAKAI_AGENT_IDENTITY ${JSON.stringify(marker)}</hook_result>`,
          }],
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part', uuid: 'fresh-reply', turnId: 'turn-1',
          part: { type: 'text', text: 'fresh reply' },
        },
      }),
      '',
    ].join('\n'));

    const ingested = await composed.runtime.ingestNow();
    assert.equal(ingested.kind, 'ok');
    assert.equal(ingested.kind === 'ok' && ingested.value.sessionsRegistered, 9,
      'fresh evidence plus the bounded eight-source history lane are processed');
    const sessions = await composed.runtime.listProviderSessions();
    assert.equal(sessions.kind, 'ok');
    assert.deepEqual(
      sessions.kind === 'ok' && sessions.value
        .filter((session) => session.agentId !== undefined)
        .map((session) => session.agentId),
      [agentId],
    );
    assert.equal(sessions.kind === 'ok' && sessions.value
      .filter((session) => session.status === 'discovered-only').length, 8);
    const lines = await composed.runtime.listTranscriptLines();
    assert.equal(
      lines.kind === 'ok' && lines.value.some((line) => line.text === 'fresh reply'),
      true,
    );
  } finally {
    await composed.close();
  }
});
