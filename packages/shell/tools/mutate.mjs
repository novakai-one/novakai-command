#!/usr/bin/env node
// shell/tools/mutate.mjs — run the honesty laws' teeth.
//
// Applies each mutant in `mutants.mjs` to the real source, runs the whole shell
// suite, and restores the file. A mutant the suite does not notice is reported
// as SURVIVED and the run exits non-zero: the law it names is currently a
// comment rather than a guarantee.
//
// Why the whole suite and not the one file that "should" catch it: a scoped run
// encodes a guess about which test owns the law, and the guess is the thing most
// likely to be wrong. The suite is 2.5s. The guess is not worth it.
//
//   node tools/mutate.mjs                 # every mutant
//   node tools/mutate.mjs --only NOTE-07  # one, or a comma-separated list
//   node tools/mutate.mjs --dry           # anchors only: no tests, no edits
//
// `--dry` exists because the failure mode of a mutation manifest is silence. An
// anchor that no longer matches the source cannot be applied, and a runner that
// shrugged at that would report a green board for mutants it never ran. Run it
// in CI beside the lint gates; it takes milliseconds.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { MUTANTS } from './mutants.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const onlyFlag = args.indexOf('--only');
const only = onlyFlag === -1 ? null : new Set((args[onlyFlag + 1] ?? '').split(','));

const selected = only === null ? MUTANTS : MUTANTS.filter((m) => only.has(m.id));
if (selected.length === 0) {
  console.error(`no mutants matched ${[...(only ?? [])].join(',')}`);
  process.exit(2);
}

/**
 * The one thing this runner must never get wrong.
 *
 * If `from` is missing the mutant cannot be applied; if it appears twice we do
 * not know which occurrence a report is about. Either way the honest answer is
 * an error, never a verdict — a stale anchor silently reporting KILLED is worse
 * than no mutation testing at all, because it reads as evidence.
 */
function anchor(mutant) {
  const path = resolve(mutant.file);
  const source = readFileSync(path, 'utf8');
  const hits = source.split(mutant.from).length - 1;
  if (hits !== 1) {
    return { path, source, error: `anchor occurs ${hits}× (expected exactly 1)` };
  }
  return { path, source, error: null };
}

const stale = [];
for (const mutant of selected) {
  const { error } = anchor(mutant);
  if (error !== null) stale.push(`${mutant.id} · ${mutant.file} · ${error}`);
}
if (stale.length > 0) {
  console.error('STALE ANCHORS — these mutants cannot be applied:\n');
  for (const line of stale) console.error(`  ${line}`);
  console.error('\nThe source moved under the manifest. Re-aim them at the law,');
  console.error('do not delete them: an unguarded law is why they exist.');
  process.exit(1);
}

if (dry) {
  console.log(`ANCHORS GREEN — ${selected.length} mutants still apply cleanly.`);
  process.exit(0);
}

// Restoration is not optional and not conditional. A run interrupted at the
// wrong moment would otherwise leave a deliberately broken line in the tree,
// and the next person to look would be debugging our test harness by accident.
let inFlight = null;
const restore = () => {
  if (inFlight === null) return;
  writeFileSync(inFlight.path, inFlight.source, 'utf8');
  inFlight = null;
};
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const results = [];
for (const mutant of selected) {
  const { path, source } = anchor(mutant);
  inFlight = { path, source };
  writeFileSync(path, source.replace(mutant.from, mutant.to), 'utf8');
  const run = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
    encoding: 'utf8', stdio: 'pipe',
  });
  restore();
  // Non-zero is a kill: a failing assertion and a crashed suite both mean the
  // tests noticed. Zero means the suite ran happily over broken behaviour.
  const killed = run.status !== 0;
  results.push({ ...mutant, killed });
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${mutant.id}  ${mutant.law.split('—')[0].trim()}`);
}

const survivors = results.filter((r) => !r.killed);
console.log(`\n${results.length} aimed · ${results.length - survivors.length} killed · ${survivors.length} survived`);

if (survivors.length > 0) {
  console.log('\nSURVIVORS — laws the suite does not currently hold:\n');
  for (const s of survivors) {
    console.log(`  ${s.id} (${s.slice}) ${s.file}`);
    console.log(`      ${s.law}`);
    console.log(`      ${s.from.trim()}`);
    console.log(`   →  ${s.to.trim()}\n`);
  }
  process.exit(1);
}
console.log('MUTATION GATE GREEN');
