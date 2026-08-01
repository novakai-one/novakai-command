// One production writer per Run fact (§3.3, red gate 13, §18 B3b superseded route).
//
// Foundation already refuses a B3b kind through a foreign scoped handle, and
// `b3b-registry.test.ts` proves it. That stops the wrong CAPABILITY writing a
// Run fact. It does not stop a second copy of the RIGHT capability appearing —
// a second composition, a second store, a helper that writes `agentRun` from
// somewhere convenient — and two writers of one fact is how a slice starts
// disagreeing with itself.
//
// So this test is about the source tree rather than the store: for each Run
// fact there is exactly one module that can write it, and exactly one place
// that composes the thing that owns it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_KINDS } from '../core/runs-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** Production TypeScript only: tests are allowed to build whatever they need. */
function productionSources(from: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'tests') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      found.push(full);
    }
  };
  walk(from);
  return found;
}

const relative = (file: string): string => path.relative(repoRoot, file);

test('exactly one module composes the Runs store, and one composes governed Agents', () => {
  const composers = { runs: [] as string[], agents: [] as string[] };
  for (const file of productionSources(path.join(repoRoot, 'packages'))) {
    const source = readFileSync(file, 'utf8');
    // The definition itself is not a second composer.
    if (/\bcreateRunsStore\s*\(/.test(source)
      && !file.endsWith(path.join('agent-runtime', 'core', 'runs-store.ts'))) {
      composers.runs.push(relative(file));
    }
    if (/\bcreateGovernedAgentsStore\s*\(/.test(source)
      && !file.endsWith(path.join('b3', 'core', 'store.ts'))) {
      composers.agents.push(relative(file));
    }
  }
  assert.deepEqual(composers.runs, ['packages/agent-runtime/core/runs-compose.ts'],
    'a second Runs store would be a second writer of every Run fact');
  assert.deepEqual(composers.agents, ['packages/agents/b3/core/compose.ts'],
    'a second governed-Agents store would be a second writer of every role and grant');
});

test('nothing outside the Runtime core names a Run fact in a durable write', () => {
  const offenders: string[] = [];
  // `store.create<X>` / `store.update<X>` is how a Run fact is written. Anywhere
  // else naming one of these kinds against a write is a second writer.
  const writes = /\.(?:create|update)\s*(?:<[^>]*>)?\s*\(/;
  for (const file of productionSources(path.join(repoRoot, 'packages'))) {
    if (file.includes(path.join('agent-runtime', 'core'))) continue;
    // Foundation is the engine every capability writes THROUGH, and the
    // registry that names every kind. It originates no Run fact of its own, so
    // naming one is its job rather than a second writer.
    if (file.includes(`${path.sep}foundation${path.sep}`)) continue;
    const source = readFileSync(file, 'utf8');
    if (!writes.test(source)) continue;
    for (const kind of RUNTIME_KINDS) {
      if (new RegExp(`['"\`]${kind}['"\`]`).test(source)) {
        offenders.push(`${relative(file)} -> ${kind}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the legacy Agents tree does not know the B3b Run kinds exist', () => {
  // The superseded route (§18) migrates one vertical path at a time. What it
  // must never do is leave the OLD path writing the NEW facts alongside the
  // new one — so the legacy tree is checked for the vocabulary, not just the
  // calls. If it cannot name a Run fact, it cannot write one.
  const offenders: string[] = [];
  for (const file of productionSources(path.join(repoRoot, 'packages', 'agents', 'core'))) {
    const source = readFileSync(file, 'utf8');
    for (const kind of RUNTIME_KINDS) {
      if (new RegExp(`['"\`]${kind}['"\`]`).test(source)) {
        offenders.push(`${relative(file)} -> ${kind}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the governed spawn has exactly one production door', () => {
  // §17.1's compatibility executable "owns no policy and has no separate
  // implementation". The cheapest way to hold red gate 23 is for there to be
  // nothing in it that COULD drift, so this checks that it still forwards
  // rather than having quietly grown a body.
  const compatibility = readFileSync(
    path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-agent-spawn.ts'), 'utf8',
  );
  assert.match(compatibility, /import\(['"]\.\/nvk-agent\.js['"]\)/,
    'the compatibility executable must hand over to the real command');
  const body = compatibility
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  assert.ok(body.length <= 5,
    `nvk-agent-spawn has grown a body (${String(body.length)} lines) — that is a second policy path`);

  // And exactly one production module builds the b3.agent.* method table.
  const builders: string[] = [];
  for (const file of productionSources(path.join(repoRoot, 'packages'))) {
    const source = readFileSync(file, 'utf8');
    if (/['"]b3\.agent\.spawn['"]\s*:/.test(source)) builders.push(relative(file));
  }
  assert.deepEqual(builders, ['packages/server/core/b3/agent-methods.ts']);
});
