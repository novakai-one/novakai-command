// What a real provider CLI actually accepts as a turn.
//
// NOT part of any suite — it drives the three real CLIs and spends real tokens.
// Run it by hand when the delivery seam changes:
//
//     npx tsx packages/agents/governed/tests/turn-delivery-probe.mts [claude|codex|kimi]...
//
// Shift 3 measured the split Enter against `claude` alone and the conformance
// test generalised it to all three by asking each adapter for its own delivery
// shape and asserting that shape had the newly implemented form — which is a
// test of the helper, not of a provider. This probe is the missing half: no
// Novakai machinery, one raw PTY per trial, three questions.
//
//   1. does a turn with the submit key INSIDE the text write get sent?
//   2. does the same turn with the submit key as its OWN write get sent?
//   3. do embedded newlines survive delivery, or does the composer eat them?
//
// "Sent" is measured the way an outsider can measure it: the CLI produces a
// burst of output it does not produce for an unsubmitted turn. Every trial is
// interrupted the moment that is detected, so a trial costs almost nothing.
import { spawn } from 'node-pty';

const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => { setTimeout(settle, ms); });

/** The gate's real turn 1, at the length that exposed the flattened-write failure. */
const TOKENS = [
  'novakai-b3-alpha@v1#3f9a1c77e2b04d5a8c6e1f0b2d4a6c8e',
  'novakai-b3-beta@v2#7c2e5d91a8b34f60be15d3c7a09e4b2f',
];
const GATE_TURN_LINES = [
  'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
  '',
  'TASK CONTEXT: reply with the single word OK and stop',
  '',
  `Required skills, already resolved for you (${String(TOKENS.length)}, in this order):`,
  ...TOKENS.map((token, index) => `  ${String(index + 1)}. ${token}`),
  '',
  'Reply with EXACTLY ONE line and no other content: start it with SKILLS-CONFIRMED:',
  'then one space, then a JSON array of the tokens above, quoted, in the order',
  'listed. Nothing before the marker on that line, and nothing after the array.',
  '',
  '(novakai turn 0123456789ab)',
];
const SHAPED = GATE_TURN_LINES.join('\n');
const FLAT = SHAPED
  .replace(/\s*\n\s*\n\s*/gu, ' · ').replace(/\s*\n\s*/gu, ' ').trim();

/**
 * A brief whose ANSWER depends on the lines surviving. If the composer flattens
 * the turn the model sees one line and says so, which is the whole of finding 6:
 * a delivery that changes the shape of a brief changes what was asked.
 */
const COUNTING_BRIEF = [
  'Reply with only a number and nothing else: how many lines does this message have?',
  'SECOND LINE',
  'THIRD LINE',
].join('\n');

type Deliver = (write: (data: string) => void) => Promise<void>;

const inlineSubmit: Deliver = async (write) => { write(`${FLAT}${CR}`); };

const splitSubmit: Deliver = async (write) => {
  write(FLAT);
  await sleep(250);
  write(CR);
};

const pastedLines: Deliver = async (write) => {
  write(`${PASTE_START}${COUNTING_BRIEF}${PASTE_END}`);
  await sleep(250);
  write(CR);
};

const rawLines: Deliver = async (write) => {
  write(COUNTING_BRIEF);
  await sleep(250);
  write(CR);
};

/** The long gate turn with its lines INTACT — the shape that actually delivers. */
const longShaped: Deliver = async (write) => {
  write(SHAPED);
  await sleep(250);
  write(CR);
};

const longPasted: Deliver = async (write) => {
  write(`${PASTE_START}${SHAPED}${PASTE_END}`);
  await sleep(250);
  write(CR);
};

interface Trial {
  readonly name: string;
  readonly deliver: Deliver;
  readonly question: string;
}

const TRIALS: readonly Trial[] = [
  { name: 'long flat, submit key inline', deliver: inlineSubmit, question: 'is it sent?' },
  { name: 'long flat, submit key its own write', deliver: splitSubmit, question: 'is it sent?' },
  { name: 'long shaped, submit key its own write', deliver: longShaped, question: 'is it sent?' },
  { name: 'long shaped bracketed-paste', deliver: longPasted, question: 'is it sent?' },
  { name: 'short shaped, raw newlines', deliver: rawLines, question: 'how many lines arrived?' },
  { name: 'short shaped, bracketed-paste', deliver: pastedLines, question: 'how many lines arrived?' },
];

/**
 * A turn STARTED, said by the application rather than by the tty.
 *
 * The tty echoes our bytes whether or not the program read them, so byte volume
 * alone cannot tell a sent turn from a composed one. Only the application prints
 * its own interrupt hint and sets its own progress state.
 */
const BUSY = /\u001b\]9;4;3;|esc to interrupt|[A-Za-z]+…/u;

/**
 * How much the application repaints while it thinks.
 *
 * The reliable cross-provider signal, and the reason the first version of this
 * probe was wrong about codex and kimi: they paint character by character at
 * explicit cursor columns, so the literal words `esc to interrupt` never appear
 * contiguously in the byte stream even while they are on the screen. What is
 * unmistakable is the volume — a working TUI repaints its spinner continuously,
 * and a composer holding an unsent turn is silent.
 */
const REPAINTING_BYTES = 3_000;

/**
 * The agent's ANSWER, in a form the question cannot contain.
 *
 * Turn 1 says "start it with SKILLS-CONFIRMED: then one space, then a JSON
 * array" — it never spells a marker followed by an open bracket and a quote, so
 * that sequence on the screen can only have come from a reply. Whitespace is
 * removed first because every one of the three paints words at explicit cursor
 * columns and the spaces never reach the stream.
 */
const ANSWERED = /SKILLS-CONFIRMED:\["/u;

/** What a human would read off the screen, for the answer digits. */
const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/gu, '');

async function run(cli: string, trial: Trial): Promise<void> {
  const pty = spawn(cli, [], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: '/tmp', env: process.env,
  });
  let out = '';
  pty.onData((chunk) => { out += chunk; });

  // Let the TUI finish painting itself, and any MCP boot finish spinning,
  // before anything is typed at it.
  await sleep(15_000);

  await trial.deliver((data) => { pty.write(data); });
  // The composer's own echo lands in this window; what comes after it is the
  // application, not the tty.
  await sleep(2_000);
  const afterEcho = out.length;

  let busyAt: number | null = null;
  for (let waited = 0; waited < 25_000; waited += 500) {
    await sleep(500);
    const since = out.slice(afterEcho);
    const screen = plain(since);
    if (BUSY.test(screen)
      || ANSWERED.test(screen.replace(/\s+/gu, ''))
      || since.length > REPAINTING_BYTES) {
      busyAt = waited;
      break;
    }
  }
  // A short answer arrives before anyone can interrupt it, so let it land.
  if (busyAt !== null && trial.question.startsWith('how many')) await sleep(12_000);
  const tail = out.slice(afterEcho);
  if (busyAt !== null) pty.write(ESC);
  await sleep(800);
  try { pty.kill(); } catch { /* already gone */ }

  const verdict = busyAt === null
    ? 'NOT SENT'
    : `SENT (busy after ${String(busyAt)}ms, ${String(tail.length)} bytes)`;
  console.log(`${cli.padEnd(7)} ${trial.name.padEnd(38)} ${verdict}`);
  if (trial.question.startsWith('how many')) {
    const said = plain(tail).replace(/\s+/gu, ' ').trim();
    console.log(`${' '.repeat(8)}screen said: ${JSON.stringify(said.slice(-320))}`);
  }
}

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const repeat = Number(args.find((arg) => arg.startsWith('--repeat='))?.slice('--repeat='.length) ?? 1);
const wanted = args.filter((arg) => !arg.startsWith('--'));
for (const cli of wanted.length > 0 ? wanted : ['claude', 'codex', 'kimi']) {
  for (const trial of TRIALS) {
    if (only !== undefined && !trial.name.includes(only)) continue;
    for (let round = 0; round < repeat; round += 1) await run(cli, trial);
  }
}
process.exit(0);
