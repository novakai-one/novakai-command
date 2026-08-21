#!/usr/bin/env node
// Coding-standards ratchet gate. Total violations (eslint warnings +
// structural checks) may never exceed lint-baseline.json. Run with
// --update to (re)write the baseline after a legitimate shrink.
// ponytail: count-only ratchet lets violations migrate between files;
// switch to a per-file baseline if that ever bites.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_BASELINE_PATH = path.join(ROOT, 'lint-baseline-packages.json');

function runEslint() {
  let stdout;
  try {
    stdout = execFileSync('npx', ['eslint', 'packages', '--format', 'json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  return JSON.parse(stdout);
}

function reportWorstFiles(eslintResults) {
  const counted = eslintResults
    .filter((result) => result.messages.length > 0)
    .map((result) => ({ file: path.relative(ROOT, result.filePath), count: result.messages.length }))
    .sort((left, right) => right.count - left.count);
  for (const entry of counted.slice(0, 10)) {
    console.log(`  ${entry.count}\t${entry.file}`);
  }
}

function main() {
  const updateMode = process.argv.includes('--update');
  // One ratchet: the packages/ world (src is gone). New/changed code must
  // never push the count up; it may only ratchet down.
  const eslintResults = runEslint();
  let packagesCount = 0;
  for (const result of eslintResults) {
    packagesCount += result.messages.length;
  }
  const totals = { packages: packagesCount };
  console.log(`packages: eslint ${totals.packages}`);

  let failed = false;
  for (const target of ['packages']) {
    const baselinePath = PACKAGES_BASELINE_PATH;
    const total = totals[target];
    if (!existsSync(baselinePath) || updateMode) {
      writeFileSync(baselinePath, JSON.stringify({ count: total }) + '\n');
      console.log(`${target}: baseline written: ${total}`);
      continue;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).count;
    if (total > baseline) {
      console.error(`FAIL ${target}: ${total} violations > baseline ${baseline} (+${total - baseline})`);
      failed = true;
    } else if (total < baseline) {
      console.log(`PASS ${target}: ${total} < baseline ${baseline} — run \`npm run lint -- --update\` to ratchet down`);
    } else {
      console.log(`PASS ${target}: at baseline ${baseline}`);
    }
  }
  if (failed) {
    console.error('Worst files:');
    reportWorstFiles(eslintResults);
    process.exit(1);
  }
}

main();
