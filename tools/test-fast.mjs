#!/usr/bin/env node
// Tiered test runner. Usage:
//   node tools/test-fast.mjs <package-dir>            fast tier (default)
//   node tools/test-fast.mjs <package-dir> --guards   guard/structure tests only
//   node tools/test-fast.mjs <package-dir> --full     everything, from source (no build)
// Exit 0 = green or no tests in tier; exit 1 = failures.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const all = [...walk(join(pkgDir, 'tests')), ...walk(join(pkgDir, 'governed/tests'))];
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
// Run with the package as cwd — several tests resolve repo/package paths from
// process.cwd() (written for `npm test`, which runs in the package dir), so
// the runner must reproduce that whether invoked from the root or in-package.
// If the package has a leaked-handle guard, load it so hung tests get
// amputated instead of stacking full timeouts (server has one).
const args = existsSync(join(pkgDir, 'tests/support/no-leaked-handles.ts'))
  ? ['tsx', '--import', './tests/support/no-leaked-handles.ts', '--test', ...files.map((f) => resolve(f))]
  : ['tsx', '--test', ...files.map((f) => resolve(f))];
const res = spawnSync('npx', args, {
  stdio: 'inherit',
  cwd: resolve(pkgDir),
});
process.exit(res.status ?? 1);
