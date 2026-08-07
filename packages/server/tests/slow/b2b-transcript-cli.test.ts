import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeAgents,
  createProviderSessionRegistry,
} from '../../../agents/contract/index.js';
import {
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeTranscript,
  type SessionRef,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../../../transcript/contract/index.js';
import {
  composeTranscriptServerHost,
} from '../../core/b2b/composition.js';

const CLI = path.resolve('../../scripts/nvk.mjs');

class CliFixtureSource implements TranscriptSourceAdapter {
  async *sources(): AsyncIterable<TranscriptSource> {
    yield { provider: 'claude', sourceId: 'source_cli_fixture' };
  }

  async *read(): AsyncIterable<TranscriptSourceItem> {
    yield {
      kind: 'candidate',
      offset: 0,
      nextOffset: 10,
      content: 'cli-parent',
      line: {
        nativeId: 'parent',
        turnId: 'parent',
        turnIndex: 0,
        role: 'assistant',
        text: 'CLI parent',
        sessionRef: 'providerSession_cli' as SessionRef,
      },
    };
    yield {
      kind: 'candidate',
      offset: 10,
      nextOffset: 20,
      content: 'cli-child',
      line: {
        nativeId: 'child',
        turnId: 'child',
        turnIndex: 1,
        role: 'assistant',
        text: 'CLI child',
        parentTurnId: 'parent',
        sessionRef: 'providerSession_cli' as SessionRef,
      },
    };
  }
}

function invoke(root: string, token: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_ROOT: root,
      NOVAKAI_TOKEN: token,
    },
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for transcript ingestion');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test('nvk transcript provides CLI parity for all three read-only queries', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-cli-'));
  const root = path.join(workspace, '.novakai');
  try {
    const transcript = composeTranscript({
      root,
      source: new CliFixtureSource(),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok && ingested.value.added, 2);
    const token = mintToken(
      root,
      'person_cli',
      ['transcriptLine'],
      'person_local',
    );

    const ingest = invoke(root, token.bearer, [
      'transcript',
      'ingest',
    ]);
    assert.equal(ingest.status, 0, ingest.stderr);
    assert.deepEqual(
      JSON.parse(ingest.stdout),
      { added: 0, duplicates: 0, skipped: [], diagnostics: [] },
    );

    const status = invoke(root, token.bearer, [
      'transcript',
      'status',
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(
      JSON.parse(status.stdout),
      {
        running: false,
        idle: true,
        lastError: null,
        latched: false,
      },
    );

    const bySession = invoke(root, token.bearer, [
      'transcript',
      'lines-by-session',
      '--session', 'providerSession_cli',
    ]);
    assert.equal(bySession.status, 0, bySession.stderr);
    assert.deepEqual(
      (JSON.parse(bySession.stdout) as Array<{ text: string }>)
        .map(({ text }) => text),
      ['CLI parent', 'CLI child'],
    );

    const byProvider = invoke(root, token.bearer, [
      'transcript',
      'lines-by-provider',
      '--provider', 'claude',
      '--since', '2026-01-01T00:00:00.000Z',
    ]);
    assert.equal(byProvider.status, 0, byProvider.stderr);
    assert.equal(JSON.parse(byProvider.stdout).length, 2);

    const tree = invoke(root, token.bearer, [
      'transcript',
      'subagent-tree',
      '--turn', 'claude:parent',
    ]);
    assert.equal(tree.status, 0, tree.stderr);
    assert.deepEqual(
      (JSON.parse(tree.stdout) as Array<{ text: string }>)
        .map(({ text }) => text),
      ['CLI child'],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('nvk transcript lines-by-session returns rows ingested by the real worker composition', async () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'nvk-transcript-cli-real-source-'),
  );
  const root = path.join(workspace, '.novakai');
  const providerHome = path.join(workspace, 'provider-home');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const agentsContext = composeAgents({
    root,
    principal: 'person_cli',
    allowMock: false,
  });
  const sessions = createProviderSessionRegistry(agentsContext);
  let host: ReturnType<typeof composeTranscriptServerHost> | undefined;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    mkdirSync(providerHome, { recursive: true });
    writeFileSync(
      destination,
      `${JSON.stringify({
        kind: 'event',
        envelope: {
          seq: 1,
          type: 'assistant_output',
          payload: {
            agentId: 'agent_cli_child',
            parentAgentId: 'agent_cli_parent',
            output: 'real composition CLI row',
            sessionId: 'native_cli_session',
            turnId: 1,
          },
        },
      })}\n`,
    );
    assert.equal(
      (await sessions.register({
        sessionId: 'providerSession_cli',
        agentId: 'agent_cli_child',
        provider: 'kimi',
        providerConversationId: 'native_cli_session',
        cwd: workspace,
        model: 'fixture',
      })).ok,
      true,
    );
    assert.equal(
      (await sessions.register({
        sessionId: 'providerSession_cli_parent',
        agentId: 'agent_cli_parent',
        provider: 'kimi',
        providerConversationId: 'native_cli_parent',
        cwd: workspace,
        model: 'fixture',
      })).ok,
      true,
    );

    host = composeTranscriptServerHost({
      root,
      providerHome,
      watcherIntervalMs: 20,
      ingestIntervalMs: 20,
    });
    host.topology.start();
    await waitFor(() => (host?.topology.status().runs ?? 0) >= 1);
    await host.topology.stop();

    const token = mintToken(
      root,
      'person_cli',
      ['transcriptLine'],
      'person_local',
    );
    const result = invoke(root, token.bearer, [
      'transcript',
      'lines-by-session',
      '--session', 'providerSession_cli',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (JSON.parse(result.stdout) as Array<{
        text: string;
        agentId?: string;
        parentAgentId?: string;
      }>).map((line) => ({
        text: line.text,
        agentId: line.agentId,
        parentAgentId: line.parentAgentId,
      })),
      [{
        text: 'real composition CLI row',
        agentId: 'agent_cli_child',
        parentAgentId: 'agent_cli_parent',
      }],
    );
  } finally {
    await host?.topology.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('nvk transcript read queries require a transcriptLine grant', () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'nvk-transcript-cli-auth-'),
  );
  const root = path.join(workspace, '.novakai');
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project'],
      'person_local',
    );
    const result = invoke(root, token.bearer, [
      'transcript',
      'lines-by-provider',
      '--provider', 'kimi',
    ]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'AuthFailed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
