import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeTranscript,
  createRawTranscriptSource,
} from '../contract/index.js';

const fixtureRoot = fileURLToPath(
  new URL('../../tests/fixtures/', import.meta.url),
);

test('Kimi raw-copy adapter preserves exposed attribution and journals an unresolved session handle', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-adapter-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'event.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(fixtureRoot, 'kimi', 'event.jsonl'), destination);
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.deepEqual(
      {
        added: ingested.value.added,
        duplicates: ingested.value.duplicates,
        skipped: ingested.value.skipped.length,
        diagnostics: ingested.value.diagnostics.map(
          (entry) => entry.diagnostic?.code,
        ),
      },
      {
        added: 1,
        duplicates: 0,
        skipped: 0,
        diagnostics: ['session_ref_unresolved'],
      },
    );

    const queried = await transcript.linesByProvider('kimi');
    assert.equal(queried.ok, true);
    assert.deepEqual(
      queried.ok
        ? queried.value.map((line) => ({
            role: line.role,
            text: line.text,
            turnId: line.turnId,
            parentTurnId: line.parentTurnId,
            agentId: line.agentId,
            parentAgentId: line.parentAgentId,
            sessionRef: line.sessionRef,
            tokenUsage: line.tokenUsage,
          }))
        : null,
      [{
        role: 'assistant',
        text: 'synthetic kimi response',
        turnId: 'kimi:turn_child_fixture',
        parentTurnId: 'kimi:turn_parent_fixture',
        agentId: 'agent_child_fixture',
        parentAgentId: 'agent_parent_fixture',
        sessionRef: undefined,
        tokenUsage: { input: 2, output: 3 },
      }],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
