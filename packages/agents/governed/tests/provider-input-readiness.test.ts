// Each provider's `inputReadyOn` against that provider's OWN boot paint
// (NVK-KIMI-079).
//
// The fixtures are real: three CLIs spawned on a real PTY at 120 columns with
// nothing written to them, every chunk stamped. Harness kept at
// `build-reports/nvk079/boot-capture.mjs`. `claude-capability-burst.screen.txt`
// is the other end of it — the first 77 bytes of
// `build-reports/nvk078/probe-ready1.screen.txt`, which is exactly what was on
// the screen in all seven arms that lost their turn.
//
// Two questions per provider, and both matter:
//   - is it FALSE while the CLI is still handshaking (or the turn dies), and
//   - is it TRUE by a time the 15 s deadline comfortably covers (or the gate
//     refuses a provider that was fine).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeInputReadyOn, codexInputReadyOn, kimiInputReadyOn,
} from '../adapters/providers/input-readiness.js';
import { createClaudeAdapter } from '../adapters/providers/claude.js';
import { createCodexAdapter } from '../adapters/providers/codex.js';
import { createKimiAdapter } from '../adapters/providers/kimi.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Terminal's readiness deadline. A predicate slower than this refuses a turn. */
const DEADLINE_MS = 15_000;

interface Capture {
  readonly bytes: Buffer;
  /** `[elapsedMs, cumulativeBytes]` after each chunk the PTY produced. */
  readonly timeline: readonly (readonly [number, number])[];
}

function capture(name: string): Capture {
  const timeline = readFileSync(path.join(FIXTURES, `${name}.timeline.txt`), 'utf8')
    .trim().split('\n')
    .map((line) => {
      const parsed = /(\d+)ms\s+(\d+)B/u.exec(line);
      assert.ok(parsed !== null, `unreadable timeline row: ${line}`);
      return [Number(parsed[1]), Number(parsed[2])] as const;
    });
  return { bytes: readFileSync(path.join(FIXTURES, `${name}.screen.txt`)), timeline };
}

/** When the predicate first becomes true, replayed chunk by chunk. */
function firstTrueMs(subject: Capture, ready: (screen: string) => boolean): number | null {
  for (const [elapsedMs, byteCount] of subject.timeline) {
    if (ready(subject.bytes.subarray(0, byteCount).toString('utf8'))) return elapsedMs;
  }
  return null;
}

const PROVIDERS = [
  { name: 'claude', fixture: 'boot-claude-2.1.219', ready: claudeInputReadyOn },
  { name: 'codex', fixture: 'boot-codex-0.146.0', ready: codexInputReadyOn },
  { name: 'kimi', fixture: 'boot-kimi-0.32.0', ready: kimiInputReadyOn },
] as const;

for (const provider of PROVIDERS) {
  test(`${provider.name} is not ready on an empty screen and is ready well inside the deadline`, () => {
    assert.equal(provider.ready(''), false, 'a session that has painted NOTHING is not ready');

    const subject = capture(provider.fixture);
    const readyAt = firstTrueMs(subject, provider.ready);
    assert.ok(readyAt !== null, `${provider.name} never became ready in its own boot capture`);
    assert.ok(readyAt < DEADLINE_MS,
      `${provider.name} became ready at ${String(readyAt)}ms, past the ${String(DEADLINE_MS)}ms deadline`);
    assert.ok(provider.ready(subject.bytes.toString('utf8')),
      `${provider.name} is not ready on its own settled boot screen`);
  });
}

test('claude is NOT ready on the capability burst that ate seven turns', () => {
  const burst = readFileSync(path.join(FIXTURES, 'claude-capability-burst.screen.txt'), 'utf8');
  assert.equal(burst.length, 77, 'the fixture is no longer the measured 77-byte burst');
  assert.equal(claudeInputReadyOn(burst), false,
    'the exact screen every lost turn was written into now reads as ready');

  // And the same screen replayed as the "output arrived, then went quiet"
  // heuristic saw it. That heuristic resolved HERE and lost 3 of 3, which is
  // why readiness is a paint and not a stopwatch.
  const settled = capture('boot-claude-2.1.219');
  const at77 = settled.bytes.subarray(0, 77).toString('utf8');
  assert.equal(claudeInputReadyOn(at77), false);
});

test('no provider borrows another one\'s composer shape', () => {
  const claude = capture('boot-claude-2.1.219').bytes.toString('utf8');
  const codex = capture('boot-codex-0.146.0').bytes.toString('utf8');
  const kimi = capture('boot-kimi-0.32.0').bytes.toString('utf8');

  // Claude draws no rounded box at all, so codex's and kimi's tests would hang
  // on it for the full deadline and then refuse a healthy session.
  assert.equal(codexInputReadyOn(claude), false);
  assert.equal(kimiInputReadyOn(claude), false);

  // The one that matters most: kimi's BANNER satisfies claude's two-rule test
  // before kimi's composer exists. Sharing one predicate would reintroduce the
  // exact defect, one provider over.
  const kimiBannerOnly = capture('boot-kimi-0.32.0');
  const bannerBytes = kimiBannerOnly.timeline
    .map(([, byteCount]) => byteCount)
    .find((byteCount) => claudeInputReadyOn(
      kimiBannerOnly.bytes.subarray(0, byteCount).toString('utf8'),
    ));
  assert.ok(bannerBytes !== undefined);
  assert.equal(
    kimiInputReadyOn(kimiBannerOnly.bytes.subarray(0, bannerBytes).toString('utf8')),
    false,
    'kimi called itself ready on the paint where only its banner box existed',
  );
  assert.equal(claudeInputReadyOn(kimi), true, 'the fixture no longer shows the overlap');
});

test('every production adapter answers the readiness question itself', async () => {
  const adapters = [
    createClaudeAdapter(), createCodexAdapter(), createKimiAdapter(),
  ];
  const burst = readFileSync(path.join(FIXTURES, 'claude-capability-burst.screen.txt'), 'utf8');
  for (const adapter of adapters) {
    assert.equal(typeof adapter.inputReadyOn, 'function', `${adapter.provider} declares no predicate`);
    assert.equal(adapter.inputReadyOn(burst), false,
      `${adapter.provider} reports ready on a bare capability burst`);
  }
});
