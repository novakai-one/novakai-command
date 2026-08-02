// §18.1's cutover runs before any handle opens under the root. The Runtime's
// boot gate enforces that — but the Runtime is NOT the first thing to open a
// handle there. `nvk token mint` is: §13 disposition 4 makes minting
// deliberately offline, and nobody can connect to the Runtime without a token.
//
// Since the config store moved onto the canonical route, that mint writes
// `stores/config.jsonl` and `stores/traces.jsonl`. On a root that still holds
// the B1-era flat `config.jsonl` / `traces.jsonl`, those two kinds then exist on
// BOTH routes with no cutover receipt — which is exactly the state §18.1 turns
// into a blocked boot. So the operator's only path to a token is also the one
// that locks the Runtime out of that root permanently, with no published way
// back: the same unwinnable shape as the sequence-0 lock.
//
// The legacy side of the fixture is written by the product's own config store
// pointed at the pre-canonical route, so nothing here can be more correct than
// the code that wrote it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { openConfigStore } from '../contract/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MINT_CLI = path.resolve(here, '..', 'cli', 'nvk-token.ts');

const roots: string[] = [];

function scratch(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-preboot-'));
  roots.push(made);
  return made;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function mint(root: string): void {
  execFileSync('npx', ['tsx', MINT_CLI, 'mint', 'person_chris',
    '--grants', 'conversationView', '--roles', 'Human'], {
    cwd: path.resolve(here, '..'),
    env: { ...process.env, NOVAKAI_ROOT: root },
    encoding: 'utf8',
  });
}

test('minting a token on a legacy root does not lock the Runtime out of it', async () => {
  const root = scratch();

  // A B1-era root: the config store pointed at the route it used before the
  // canonical one existed, so `config.jsonl` and `traces.jsonl` sit flat.
  const legacy = await openConfigStore({ root, dataRoot: root, principal: 'sys_spine' });
  assert.equal(legacy.ok, true, legacy.ok ? '' : legacy.error.message);
  assert.equal(existsSync(path.join(root, 'config.jsonl')), true, 'legacy config.jsonl seeded');
  assert.equal(existsSync(path.join(root, 'traces.jsonl')), true, 'legacy traces.jsonl seeded');

  // The one command an operator must run before the Runtime is reachable.
  mint(root);

  // The precondition this test exists for: both kinds now sit on both routes.
  assert.equal(existsSync(path.join(root, 'stores', 'config.jsonl')), true);
  assert.equal(existsSync(path.join(root, 'stores', 'traces.jsonl')), true);

  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    // The migration actually happened rather than being skipped: the receipt
    // §18.1 gates canonical dispatch on is on disk.
    assert.equal(
      existsSync(path.join(root, 'stores', 'storeRouteCutovers.jsonl')), true,
      'the cutover receipt §18.1 gates dispatch on was never written',
    );
    // And the token the operator minted is still the one the Runtime serves.
    const reopened = await openConfigStore({ root, principal: 'sys_spine' });
    assert.equal(reopened.ok, true, reopened.ok ? '' : reopened.error.message);
    if (!reopened.ok) return;
    assert.deepEqual(
      reopened.value.current().principals.map((principal) => principal.personId),
      ['person_chris'],
      'the minted principal did not survive the cutover',
    );
  } finally {
    await host.close();
  }
});
