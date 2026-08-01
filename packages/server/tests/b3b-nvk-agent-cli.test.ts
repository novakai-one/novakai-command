// `nvk agent spawn` is the command the onboarding promises and DEC-B3V4-04
// names as canonical (§17.1, probe M-1).
//
// The verbs all worked — as `npx tsx <absolute path>/nvk-agent.ts`. An operator
// typing what the docs say got a usage error, because `nvk` routed only
// project|artifact|spine|transcript. The runtime and terminal families were
// missing the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { chatRole } from './governed-role.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

function runNvk(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    child.on('close', (code) => { resolve({ code, out }); });
  });
}

for (const group of ['agent', 'runtime', 'terminal'] as const) {
  test(`nvk ${group} reaches its CLI rather than a usage error`, async () => {
    const seen = await runNvk([group]);
    assert.equal(seen.out.includes('usage: nvk project|artifact'), false,
      `nvk ${group} fell through to the top-level usage error: ${seen.out}`);
    // Every B3 CLI prints its own verb list when given none. That list naming
    // the group's verbs is the proof the right executable answered.
    assert.equal(seen.out.length > 0, true, `nvk ${group} said nothing at all`);
  });
}

test('nvk agent spawn is a real command, and says what it needs', async () => {
  // No --role, so it must be REFUSED by nvk-agent itself — a validation error
  // from the agent CLI, not "I have never heard of `agent`".
  const seen = await runNvk(['agent', 'spawn', '--json']);
  assert.equal(seen.out.includes('usage: nvk project|artifact'), false,
    `nvk agent spawn is still unrouted: ${seen.out}`);
  assert.equal(/role/i.test(seen.out), true,
    `nvk agent spawn did not ask for a role: ${seen.out}`);
});

test('an operator can define a role and spawn from a clean data root, by CLI alone', async () => {
  // Probe M-2: `b3.agent.createRole` was on the wire and used by tests and the
  // bundled proof, and no operator surface called it — so from a fresh
  // `.novakai` the promise "spawn a governed agent from anywhere" could not be
  // kept by anyone typing commands.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-cli-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const file = path.join(root, 'role.json');
    writeFileSync(file, JSON.stringify(chatRole('cli-builder')), 'utf8');
    const where = ['--root', root, '--port', String(host.port), '--json'];

    const defined = await runNvk(['agent', 'define-role', '--file', file, ...where]);
    assert.equal(defined.code, 0, `define-role failed: ${defined.out}`);

    const spawned = await runNvk([
      'agent', 'spawn', '--role', 'cli-builder', '--name', 'CLI Builder',
      '--cwd', root, ...where,
    ]);
    assert.equal(spawned.code, 0, `spawn failed: ${spawned.out}`);
    assert.equal(spawned.out.includes('agentRun_'), true,
      `spawn produced no Run: ${spawned.out}`);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
