#!/usr/bin/env node
// Coding-standards ratchet gate. Total violations (eslint warnings +
// structural checks) may never exceed lint-baseline.json. Run with
// --update to (re)write the baseline after a legitimate shrink.
// ponytail: count-only ratchet lets violations migrate between files;
// switch to a per-file baseline if that ever bites.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(ROOT, 'lint-baseline.json');
const PACKAGES_BASELINE_PATH = path.join(ROOT, 'lint-baseline-packages.json');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);

function runEslint() {
  let stdout;
  try {
    stdout = execFileSync('npx', ['eslint', 'src', 'packages', '--format', 'json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  return JSON.parse(stdout);
}

function walkDirs(dir, found) {
  found.push(dir);
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    if (child.name === 'dist' || child.name === 'node_modules') continue;
    walkDirs(path.join(dir, child.name), found);
  }
}

function codeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => entry.name);
}

function structuralViolations() {
  const problems = [];
  const dirs = [];
  walkDirs(path.join(ROOT, 'src'), dirs);
  for (const dir of dirs) {
    const files = codeFiles(dir);
    if (files.length > 2) {
      problems.push(`${path.relative(ROOT, dir)}: ${files.length} code files (max 2) — use subdirectories`);
    }
    const hasTsx = files.some((name) => name.endsWith('.tsx'));
    const hasCss = readdirSync(dir).some((name) => name.endsWith('.css'));
    if (hasTsx && !hasCss) {
      problems.push(`${path.relative(ROOT, dir)}: .tsx module without its own .css file`);
    }
  }
  return problems;
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
  // Two independent ratchets: legacy src (eslint + structural) and the
  // packages/ world (eslint only — src's max-2-files/.css structural rules
  // are UI conventions that do not apply to package layout). New/changed
  // code must never push either count up; counts may only ratchet down.
  const eslintResults = runEslint();
  const byTarget = { src: 0, packages: 0 };
  for (const result of eslintResults) {
    const rel = path.relative(ROOT, result.filePath);
    const target = rel.startsWith('packages/') ? 'packages' : 'src';
    byTarget[target] += result.messages.length;
  }
  const structural = structuralViolations();
  const totals = { src: byTarget.src + structural.length, packages: byTarget.packages };
  console.log(`src: eslint ${byTarget.src} + structural ${structural.length} = ${totals.src}  |  packages: eslint ${totals.packages}`);

  let failed = false;
  for (const target of ['src', 'packages']) {
    const baselinePath = target === 'src' ? BASELINE_PATH : PACKAGES_BASELINE_PATH;
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
    for (const problem of structural) console.error(`  structural: ${problem}`);
    process.exit(1);
  }
}

main();
