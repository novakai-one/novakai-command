import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeTranscript,
  type SessionRef,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../../transcript/contract/index.js';

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
