import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultMessagingRuntime } from '../../contract/compose/ingestion.js';
import type { AgentDirectory, AgentDirectoryEntry } from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { ProviderSessionId } from '../../contract/types.js';

const row = (resumeId: string, text: string): string => `${JSON.stringify({
  type: 'assistant',
  uuid: `line-${resumeId}`,
  sessionId: resumeId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})}\n`;

function fakeDirectories() {
  const agents = new Map<string, AgentDirectoryEntry>();
  const bySession = new Map<string, string>();
  const ensured: string[] = [];
  const attached: string[] = [];
  const views: string[] = [];
  const directory: AgentDirectory = {
    async get(agentId) { return agents.get(agentId) ?? null; },
    async deliveryReadiness() { return 'idle'; },
    async ensureForSession(input) {
      const prior = bySession.get(input.sessionId);
      const agentId = prior ?? `agent_external_${String(bySession.size + 1)}`;
      if (prior === undefined) {
        ensured.push(input.sessionId);
        bySession.set(input.sessionId, agentId);
        agents.set(agentId, {
          agentId,
          provider: input.provider,
          currentProviderSessionId: null,
        });
      }
      return { ok: true, agent: agents.get(agentId)! };
    },
    async attachProviderSession(agentId, providerSessionId) {
      const agent = agents.get(agentId)!;
      agents.set(agentId, { ...agent, currentProviderSessionId: providerSessionId as ProviderSessionId });
      attached.push(providerSessionId);
      return { ok: true, state: 'attached' };
    },
  };
  const conversations: ConversationDirectory = {
    async ensureForAdoptedAgent(input) {
      views.push(input.agent.agentId);
      return { conversationId: `conv_${input.agent.agentId}` };
    },
    async ensureForAgentPair(input) {
      return { conversationId: `conv_${input.participantAgentIds.join('_')}` };
    },
  };
  return { directory, conversations, ensured, attached, views };
}

test('external adoption is root-scoped, capped and idempotent across ticks', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nvk-external-adoption-'));
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const projects = path.join(providerHome, '.claude', 'projects');
  const eligible = path.join(projects, 'eligible');
  const outside = path.join(projects, 'outside');
  await mkdir(eligible, { recursive: true });
  await mkdir(outside, { recursive: true });
  await Promise.all([
    writeFile(path.join(eligible, 'a.jsonl'), row('external-a', 'A')),
    writeFile(path.join(eligible, 'b.jsonl'), row('external-b', 'B')),
    writeFile(path.join(eligible, 'c.jsonl'), row('external-c', 'C')),
    writeFile(path.join(eligible, 'partial.jsonl'), '{"type":"assistant"'),
    writeFile(path.join(outside, 'hidden.jsonl'), row('outside-hidden', 'hidden')),
  ]);
  const fakes = fakeDirectories();
  const composed = await createDefaultMessagingRuntime({
    root,
    providerHome,
    installIdentityHooks: false,
    agentDirectory: fakes.directory,
    conversationPrincipalId: 'person_chris',
    externalAdoption: {
      roots: { claude: [eligible] },
      limitPerTick: 2,
      assignment: {
        teamId: 'team_external-session-visibility',
        missionId: 'mission_external-session-visibility',
      },
    },
  });
  try {
    const first = await composed.runtime.ingestNow();
    assert.equal(first.kind, 'ok');
    if (first.kind === 'ok') assert.equal(first.value.sessionsAdopted, 2);
    const second = await composed.runtime.ingestNow();
    assert.equal(second.kind, 'ok');
    if (second.kind === 'ok') assert.equal(second.value.sessionsAdopted, 1);
    const third = await composed.runtime.ingestNow();
    assert.equal(third.kind, 'ok');
    if (third.kind === 'ok') assert.equal(third.value.sessionsAdopted, 0);

    const sessions = await composed.runtime.listProviderSessions();
    const lines = await composed.runtime.listTranscriptLines();
    const views = await composed.runtime.listConversationViews();
    assert.equal(sessions.kind, 'ok');
    assert.equal(lines.kind, 'ok');
    assert.equal(views.kind, 'ok');
    if (sessions.kind !== 'ok' || lines.kind !== 'ok' || views.kind !== 'ok') return;
    assert.equal(sessions.value.filter((session) => session.agentId !== undefined).length, 3);
    assert.equal(
      sessions.value.filter((session) => session.agentId !== undefined)
        .every((session) => session.status === 'idle'),
      true,
    );
    assert.equal(
      sessions.value.find((session) => session.resumeId === 'outside-hidden')?.status,
      'discovered-only',
    );
    assert.deepEqual(lines.value.map((line) => line.text).sort(), ['A', 'B', 'C']);
    assert.equal(fakes.ensured.length, 3);
    assert.equal(fakes.attached.length, 3);
    assert.equal(views.value.length, 3);
    assert.equal(views.value.every((view) => view.id.startsWith('conv_external_')), true);
  } finally {
    await composed.close();
  }
});

test('allowlisting a discovered source replays its transcript before adoption', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nvk-late-adoption-'));
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const eligible = path.join(providerHome, '.claude', 'projects', 'eligible');
  await mkdir(eligible, { recursive: true });
  await writeFile(path.join(eligible, 'late.jsonl'), row('external-late', 'late history'));

  const discovery = await createDefaultMessagingRuntime({
    root, providerHome, installIdentityHooks: false,
  });
  try {
    const first = await discovery.runtime.ingestNow();
    assert.equal(first.kind, 'ok');
    const lines = await discovery.runtime.listTranscriptLines();
    assert.equal(lines.kind, 'ok');
    if (lines.kind === 'ok') assert.equal(lines.value.length, 0);
  } finally {
    await discovery.close();
  }

  const fakes = fakeDirectories();
  const adoption = await createDefaultMessagingRuntime({
    root, providerHome, installIdentityHooks: false,
    agentDirectory: fakes.directory,
    conversationPrincipalId: 'person_chris',
    externalAdoption: {
      roots: { claude: [eligible] }, limitPerTick: 1,
      assignment: { teamId: 'team_adopted', missionId: 'mission_adopted' },
    },
  });
  try {
    const replayed = await adoption.runtime.ingestNow();
    assert.equal(replayed.kind, 'ok');
    if (replayed.kind === 'ok') assert.equal(replayed.value.sessionsAdopted, 1);
    const lines = await adoption.runtime.listTranscriptLines();
    assert.equal(lines.kind, 'ok');
    if (lines.kind === 'ok') assert.deepEqual(lines.value.map((line) => line.text), ['late history']);
  } finally {
    await adoption.close();
  }
});
