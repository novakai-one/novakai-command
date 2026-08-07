import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeTranscript,
  createRawTranscriptSource,
} from '../../contract/index.js';
import { normalizeProviderLine } from '../../adapters/provider-normalizers.js';

// Source lives at tests/slow/, compiled output at dist/tests/slow/ — the
// depth differs, so resolve the package root by walking up to tsconfig.json.
const packageRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'tsconfig.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root not found from ${dir}`);
    dir = parent;
  }
  return dir;
})();

// Fixtures are source-only (tsc does not copy .jsonl): read them from the
// package's tests/fixtures in either layout.
const fixtureRoot = path.join(packageRoot, 'tests', 'fixtures', 'codex');

async function assertLegacyEventStored(input: {
  fixtureName: string;
  role: 'user' | 'assistant';
  text: string;
}): Promise<void> {
  const fixture = path.join(fixtureRoot, input.fixtureName);
  const content = readFileSync(fixture, 'utf8').trim();
  const classified = normalizeProviderLine(
    'codex',
    content,
    0,
    Buffer.byteLength(content),
  );
  assert.equal(classified.kind, 'candidate');
  if (classified.kind !== 'candidate') return;
  assert.deepEqual(
    {
      role: classified.line.role,
      text: classified.line.text,
      turnId: classified.line.turnId,
    },
    {
      role: input.role,
      text: input.text,
      turnId: undefined,
    },
  );

  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-codex-legacy-event-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'codex',
    'legacy-event-source',
    'rollout.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(fixture, destination);
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const first = await transcript.ingest();
    assert.deepEqual(
      first.ok
        ? {
            added: first.value.added,
            duplicates: first.value.duplicates,
            skipped: first.value.skipped.length,
          }
        : null,
      { added: 1, duplicates: 0, skipped: 0 },
    );
    const firstLines = await transcript.linesByProvider('codex');
    assert.equal(firstLines.ok, true);
    if (!firstLines.ok) return;
    assert.equal(firstLines.value.length, 1);
    assert.deepEqual(
      firstLines.value.map((line) => ({
        role: line.role,
        text: line.text,
        turnId: line.turnId,
      })),
      [{
        role: input.role,
        text: input.text,
        turnId: `codex:${firstLines.value[0]!.sourceId}:0`,
      }],
    );

    const replay = await transcript.ingest();
    assert.deepEqual(
      replay.ok
        ? {
            added: replay.value.added,
            duplicates: replay.value.duplicates,
          }
        : null,
      { added: 0, duplicates: 0 },
    );
    const replayedLines = await transcript.linesByProvider('codex');
    assert.equal(
      replayedLines.ok ? replayedLines.value.length : -1,
      1,
      're-ingest preserves exactly one durable transcriptLine',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('legacy Codex id-less user events classify and store as user lines', async () => {
  await assertLegacyEventStored({
    fixtureName: 'legacy-user-event.jsonl',
    role: 'user',
    text: 'synthetic legacy Codex user message',
  });
});

test('legacy Codex id-less agent events classify and store as assistant lines', async () => {
  await assertLegacyEventStored({
    fixtureName: 'legacy-agent-event.jsonl',
    role: 'assistant',
    text: 'synthetic legacy Codex agent message',
  });
});
