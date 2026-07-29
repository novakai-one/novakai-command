import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeTranscriptServerHost,
} from '../../core/b2b/composition.js';

const base = mkdtempSync(
  path.join(tmpdir(), 'nvk-transcript-active-crash-child-'),
);
const root = path.join(base, '.novakai');
const providerHome = path.join(base, 'provider-home');
const custody = path.join(root, 'transcripts', 'kimi');
mkdirSync(providerHome, { recursive: true });
mkdirSync(custody, { recursive: true });

const rows = Array.from({ length: 160 }, (_, index) =>
  JSON.stringify({
    kind: 'event',
    envelope: {
      seq: index,
      timestamp: '2026-07-29T01:02:03.000Z',
      type: 'assistant_output',
      payload: {
        agentId: 'agent_active_crash',
        turnId: `turn_active_crash_${index}`,
        output: `synthetic active crash line ${index}`,
      },
    },
  }))
  .join('\n');
writeFileSync(path.join(custody, 'active-crash.jsonl'), `${rows}\n`);

const host = composeTranscriptServerHost({
  root,
  providerHome,
  watcherIntervalMs: 10,
  ingestIntervalMs: 10,
});
host.topology.start();

let deadline = Date.now() + 1_000;
while (!host.topology.status().ingesting && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
assert.equal(host.topology.status().ingesting, true);

const watcherState = path.join(root, 'transcripts', '.state');
rmSync(watcherState, { recursive: true });
writeFileSync(
  watcherState,
  'checkpoint directory deliberately replaced during active ingestion',
);

deadline = Date.now() + 1_000;
while (host.topology.status().running && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
const terminal = host.topology.status();
assert.equal(terminal.running, false);
assert.equal(terminal.watcherReady, false);
assert.equal(
  terminal.ingesting,
  false,
  'terminal status must clear active work before stop is called',
);
assert.match(terminal.lastError ?? '', /EEXIST|checkpoint|state/u);

process.stdout.write(`${JSON.stringify(terminal)}\n`);
await host.topology.stop();
