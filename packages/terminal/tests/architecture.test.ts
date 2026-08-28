// Architecture tests (§24.1, red gates 6 and 26).
//
// These are the rules that stop working code from quietly becoming an
// unmaintainable knot: no legacy `src/` import, no reaching past a capability's
// public door, no `dist/` path, and no import cycle among the new modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** Everything B3a added or rewrote. Old code is not retrofitted here. */
const B3A_ROOTS = [
  'packages/terminal',
  'packages/agent-runtime',
  'packages/server/core/runtime-host',
  'packages/server/cli/nvk-runtime.ts',
  'packages/server/cli/nvk-terminal.ts',
  'packages/shell/ui/screens/terminal',
  'packages/shell/app/terminalClient.ts',
  'packages/shell/contract/terminalServices.ts',
];

function sourceFiles(target: string): string[] {
  const absolute = path.join(repoRoot, target);
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(path.relative(repoRoot, child));
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

const ALL_FILES = B3A_ROOTS.flatMap(sourceFiles);

/** The src/ fence covers every package, not just the B3a roots. */
const ALL_PACKAGE_FILES = sourceFiles('packages');

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter(Boolean);
}

test('no package imports the legacy src/ lane', () => {
  const offenders: string[] = [];
  for (const file of ALL_PACKAGE_FILES) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(/from\s+'([^']+)'|import\('([^']+)'\)/);
      const specifier = match?.[1] ?? match?.[2];
      if (!specifier) return;
      if (specifier.includes('/src/') || /^(\.\.\/)+src\//.test(specifier)) {
        offenders.push(`${path.relative(repoRoot, file)}:${index + 1} -> ${specifier}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('no Build 3 module imports a Foundation dist/ or private path', () => {
  const offenders: string[] = [];
  for (const file of ALL_FILES) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('@novakai/foundation')) continue;
      if (specifier === '@novakai/foundation/contract') continue;
      offenders.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [],
    'new code must import the exported ./contract surface, never dist/ or core/');
});

test('no consumer reaches past another capability public door', () => {
  const offenders: string[] = [];
  for (const file of ALL_FILES) {
    const owner = path.relative(repoRoot, file).split(path.sep).slice(0, 2).join('/');
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('../../')) continue;
      const resolved = path.relative(repoRoot, path.resolve(path.dirname(file), specifier));
      const target = resolved.split(path.sep).slice(0, 2).join('/');
      if (target === owner || !target.startsWith('packages/')) continue;
      const isPublicDoor = resolved.includes('/contract/')
        || resolved.includes('/public/')
        // The one deliberate exception: the composition root wires the real
        // PTY adapter, which is what a composition root is FOR.
        || resolved.includes('adapters/pty-host');
      if (!isPublicDoor) offenders.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the new modules contain no import cycle', () => {
  const graph = new Map<string, string[]>();
  for (const file of ALL_FILES) {
    const edges: string[] = [];
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/, '');
      for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')]) {
        if (ALL_FILES.includes(candidate)) edges.push(candidate);
      }
    }
    graph.set(file, edges);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycles: string[] = [];
  const walk = (node: string, trail: string[]): void => {
    if (visiting.has(node)) {
      const start = trail.indexOf(node);
      cycles.push([...trail.slice(start), node].map((item) => path.relative(repoRoot, item)).join(' -> '));
      return;
    }
    if (done.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) walk(next, [...trail, node]);
    visiting.delete(node);
    done.add(node);
  };
  for (const file of ALL_FILES) walk(file, []);

  assert.deepEqual(cycles, [], 'B3a introduced an import cycle');
});

test('the Terminal core never learns about React, Electron, xterm or node-pty', () => {
  const forbidden = ['react', 'electron', 'xterm', 'node-pty'];
  const cores = ALL_FILES.filter((file) =>
    file.includes('/terminal/core/') || file.includes('/agent-runtime/core/'));
  assert.ok(cores.length > 0, 'the core file list is empty — the test is not looking at anything');
  const offenders: string[] = [];
  for (const file of cores) {
    for (const specifier of importsOf(file)) {
      if (forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
        offenders.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
