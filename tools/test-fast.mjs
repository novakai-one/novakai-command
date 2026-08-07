#!/usr/bin/env node
// Tiered test runner. Usage:
//   node tools/test-fast.mjs <package-dir>            fast tier (default)
//   node tools/test-fast.mjs <package-dir> --guards   guard/structure tests only
//   node tools/test-fast.mjs <package-dir> --full     everything, from source (no build)
// Exit 0 = green or no tests in tier; exit 1 = failures.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [, , pkgDir, ...flags] = process.argv;
if (!pkgDir) { console.error('usage: test-fast.mjs <package-dir> [--guards|--full]'); process.exit(2); }
const mode = flags.includes('--guards') ? 'guards' : flags.includes('--full') ? 'full' : 'fast';

const config = JSON.parse(readFileSync(new URL('./test-tiers.json', import.meta.url), 'utf8'));
const guards = config.guards.map((p) => new RegExp(p, 'i'));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const all = [...walk(join(pkgDir, 'tests')), ...walk(join(pkgDir, 'b3/tests'))];
const isGuard = (f) => guards.some((r) => r.test(f));
// The slow tier is a folder, not a name pattern: anything under tests/slow/.
// (Also matches when pkgDir is '.', where paths have no leading slash.)
const isSlow = (f) => /(^|\/)tests\/slow\//.test(f);
const files = all.filter((f) =>
  mode === 'guards' ? isGuard(f) :
  mode === 'full' ? true :
  !isGuard(f) && !isSlow(f));

if (files.length === 0) {
  console.log(`[test-fast] no ${mode} tests in ${pkgDir}`);
  process.exit(0);
}
console.log(`[test-fast] ${mode}: ${files.length} files in ${pkgDir}`);
const res = spawnSync('npx', ['tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
