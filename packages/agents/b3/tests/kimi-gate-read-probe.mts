// What the gate READS off a real kimi screen (NVK-KIMI-034).
//
// NOT part of any suite — it drives the real `kimi` binary and spends real
// tokens. Run it by hand when the gate's screen reading changes:
//
//     npx tsx packages/agents/b3/tests/kimi-gate-read-probe.mts
//
// The public three-generation proof fails at generation 3 with "no confirmation
// arrived before the gate timed out", and kimi's OWN wire log for that Run shows
// the model answered the gate correctly four times:
//
//     SKILLS-CONFIRMED: ["elite-codebase-engineering@v3#a1b2c3d4", ...]
//
// So the turn arrived, the model complied, and the gate did not see it. This
// probe is the missing measurement: one raw PTY at the Runtime's own viewport,
// the production delivery, and then the PRODUCTION read chain — plainText,
// sinceTheQuestion, withoutOurOwnWords, findMarkerLine — run over the bytes that
// really came back. It prints the decision and the bytes the decision was made
// on, so the failing step names itself.
import { spawn } from 'node-pty';
import { deliverTurn, findMarkerLine } from '../adapters/providers/turn-delivery.js';
import {
  bearsFingerprint, plainText, sinceTheQuestion, withoutOurOwnWords,
} from '../../../agent-runtime/core/gate-screen.js';

/** §6.3's own turn 1, as `confirmationPrompt` composes it. */
const MARKER = 'SKILLS-CONFIRMED:';
const FINGERPRINT = '(novakai turn 0123456789ab)';
const TOKENS = [
  'elite-codebase-engineering@v3#a1b2c3d4',
  'test-driven-development@v2#e5f6a7b8',
];
const TURN_ONE = [
  'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
  '',
  'TASK CONTEXT: Say the word DAMSON once, then stop.',
  '',
  `Required skills, already resolved for you (${String(TOKENS.length)}, in this order):`,
  ...TOKENS.map((token, index) => `  ${String(index + 1)}. ${token}`),
  '',
  `Reply with EXACTLY ONE line and no other content: start it with ${MARKER}`,
  'then one space, then a JSON array of the tokens above, quoted, in the order',
  'listed. Nothing before the marker on that line, and nothing after the array.',
  '',
  FINGERPRINT,
].join('\n');

/** The gate's own "our own words" set, built the way `awaitConfirmation` builds it. */
const OURS = new Set(
  TURN_ONE.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
);

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => { setTimeout(settle, ms); });

/** The answer, in the form no question can contain: marker, bracket, quote. */
const ANSWERED = /SKILLS-CONFIRMED:\["/u;

const pty = spawn(process.env.KIMI_BIN ?? 'kimi', [], {
  name: 'xterm-256color',
  cols: 400,
  rows: 40,
  cwd: process.cwd(),
  env: process.env,
});
let raw = '';
pty.onData((chunk) => { raw += chunk; });

// The Runtime types turn 1 as soon as the session is open; the delay here only
// has to be long enough that kimi's composer is reading its stdin. At 4s it is
// not — the turn echoes into the composer and sits there for ever — so the
// default is the 15s the delivery probe already found sufficient.
await sleep(Number(process.env.KIMI_BOOT_MS ?? 15_000));
const paintedBefore = plainText(raw).length;
for (const step of deliverTurn(TURN_ONE)) {
  pty.write(step.utf8Text);
  if (step.pauseMsAfter > 0) await sleep(step.pauseMsAfter);
}

/** The gate's decision, exactly as `awaitConfirmation` reaches it. */
function gateVerdict(screen: string): {
  readonly asked: boolean;
  readonly since: string | null;
  readonly line: string | null;
} {
  const asked = bearsFingerprint(screen, FINGERPRINT);
  const since = sinceTheQuestion(screen, FINGERPRINT, paintedBefore);
  if (since === null) return { asked, since, line: null };
  return { asked, since, line: findMarkerLine(withoutOurOwnWords(since, OURS), MARKER) };
}

let answeredAt: number | null = null;
for (let waited = 0; waited < 120_000; waited += 1_000) {
  await sleep(1_000);
  const screen = plainText(raw);
  const verdict = gateVerdict(screen);
  const modelAnswered = ANSWERED.test(screen.replace(/\s+/gu, ''));
  if (modelAnswered && answeredAt === null) answeredAt = waited;
  if (waited % 5_000 === 0 || (modelAnswered && answeredAt === waited)) {
    console.log(`t=${String(waited).padStart(6)}ms  bytes=${String(raw.length).padStart(7)}`
      + `  asked=${String(verdict.asked)}  since=${verdict.since === null ? 'null' : String(verdict.since.length)}`
      + `  modelAnswered=${String(modelAnswered)}  GATE=${verdict.line === null ? 'null' : 'FOUND'}`);
  }
  // Give the answer 10s to finish painting, then report on the settled screen.
  if (answeredAt !== null && waited >= answeredAt + 10_000) break;
  if (verdict.line !== null) break;
}

const screen = plainText(raw);
const verdict = gateVerdict(screen);
console.log('\n── verdict ────────────────────────────────────────────────────');
console.log(`the model answered on screen : ${String(ANSWERED.test(screen.replace(/\s+/gu, '')))}`);
console.log(`the gate found a line        : ${verdict.line === null ? 'NO' : JSON.stringify(verdict.line)}`);

const region = verdict.since ?? screen;
const at = region.lastIndexOf(MARKER);
console.log('\n── the bytes the gate judged, around the last marker ──────────');
if (at < 0) {
  console.log(`the marker is not in the judged region at all (${String(region.length)} chars)`);
  const anywhere = screen.lastIndexOf(MARKER);
  console.log(anywhere < 0
    ? 'and not on the plain screen either'
    : `but it IS on the plain screen at ${String(anywhere)} of ${String(screen.length)}`);
} else {
  const window = region.slice(Math.max(0, at - 200), at + 400);
  console.log(JSON.stringify(window));
  console.log('\n── the same window, line by line, as findMarkerLine splits it ─');
  for (const line of withoutOurOwnWords(region, OURS).split(/\r?\n/).slice(-14)) {
    console.log(JSON.stringify(line.trim()));
  }
}

// The bytes themselves, so a test can be written over what really came back
// rather than over a plausible imitation of it.
const capture = process.argv.slice(2).find((arg) => arg.startsWith('--capture='));
if (capture !== undefined) {
  const { writeFileSync } = await import('node:fs');
  const target = capture.slice('--capture='.length);
  writeFileSync(target, raw, 'utf8');
  console.log(`\ncaptured ${String(raw.length)} bytes to ${target}`);
}

pty.write(String.fromCharCode(27));
await sleep(500);
try { pty.kill(); } catch { /* already gone */ }
process.exit(0);
