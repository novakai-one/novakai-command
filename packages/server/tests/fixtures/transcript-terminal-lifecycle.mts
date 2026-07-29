import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeTranscriptServerHost,
} from '../../core/b2b/composition.js';

const base = mkdtempSync(
  path.join(tmpdir(), 'nvk-transcript-terminal-child-'),
);
const root = path.join(base, '.novakai');
const providerHome = path.join(base, 'provider-home');
mkdirSync(path.join(providerHome, '.kimi-code'), { recursive: true });
mkdirSync(path.join(root, 'transcripts'), { recursive: true });
writeFileSync(
  path.join(root, 'transcripts', '.state'),
  'checkpoint directory deliberately blocked by a regular file',
);

const host = composeTranscriptServerHost({
  root,
  providerHome,
  watcherIntervalMs: 10,
  ingestIntervalMs: 10,
});
host.topology.start();

const deadline = Date.now() + 1_000;
while (
  (
    host.topology.status().running
    || host.topology.status().ingesting
  )
  && Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const terminal = host.topology.status();
assert.equal(terminal.running, false);
assert.equal(terminal.watcherReady, false);
assert.equal(terminal.ingesting, false);
assert.match(terminal.lastError ?? '', /EEXIST|ENOTDIR|checkpoint|state/u);
const stickyError = terminal.lastError;
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(host.topology.status().lastError, stickyError);

const stoppedAt = performance.now();
await Promise.race([
  Promise.all([
    host.topology.stop(),
    host.topology.stop(),
  ]),
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('topology.stop exceeded 500ms')), 500);
  }),
]);
const stopMs = performance.now() - stoppedAt;
assert.ok(stopMs < 500);
process.stdout.write(`${JSON.stringify({
  stopMs,
  status: host.topology.status(),
})}\n`);
