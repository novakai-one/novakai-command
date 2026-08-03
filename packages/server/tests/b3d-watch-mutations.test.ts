// Lane B — the published watcher mutations through the existing nvk-ws table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3ok } from '@novakai/foundation/contract';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { composeSupervision } from '../../supervision/public/index.js';
import { buildB3SupervisionMethods } from '../core/b3/supervision-methods.js';
import { startRuntimeHost } from '../core/b3/host.js';
import type { MethodTable } from '../contract/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const HUMAN = {
  id: 'person_chris' as never,
  kind: 'human' as const,
  verifiedScopes: [],
};

function call(table: MethodTable, method: string, payload: unknown) {
  const handler = table[method];
  assert.notEqual(handler, undefined, `${method} is not on the published wire`);
  return handler!({
    contractVersion: 1,
    clientOpId: 'op_123e4567-e89b-42d3-a456-426614174020',
    payload,
  } as never) as Promise<{ readonly ok: boolean; readonly value?: unknown }>;
}

function runNvk(args: readonly string[]): Promise<{ readonly code: number | null; readonly out: string }> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    child.on('close', (code) => { resolve({ code, out }); });
  });
}

test('b3.supervision.createWatch creates one event watcher through the frozen command', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-watch-mutation-'));
  try {
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    });
    const table = buildB3SupervisionMethods({
      supervision,
      principalFor: () => HUMAN,
      activityGenerationFor: async () => 1 as never,
    });
    const created = await call(table, 'b3.supervision.createWatch', {
      subject: {
        kind: 'agent-run',
        agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
      },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    });
    assert.equal(created.ok, true);
    assert.equal((created.value as { readonly condition?: { readonly kind?: string } })
      .condition?.kind, 'run-final');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nvk watch add creates an event watcher visible through nvk watch list', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-watch-cli-'));
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost: createFakePtyHost(),
    providers: createFakeProviderAdapters(),
  });
  const where = ['--root', root, '--port', String(host.port), '--json'];
  try {
    const added = await runNvk([
      'watch', 'add',
      '--subject', 'agentRun_019fd000-0000-7000-8000-0000000000a1',
      '--when', 'run-final',
      '--notify', 'human',
      '--delivery', 'queue-only',
      ...where,
    ]);
    assert.equal(added.code, 0, added.out);
    const created = JSON.parse(added.out) as {
      readonly ok: boolean;
      readonly value: { readonly condition: { readonly kind: string } };
    };
    assert.equal(created.ok, true);
    assert.equal(created.value.condition.kind, 'run-final');

    const listed = await runNvk(['watch', 'list', ...where]);
    assert.equal(listed.code, 0, listed.out);
    const page = JSON.parse(listed.out) as {
      readonly value: { readonly rules: readonly { readonly id: string }[] };
    };
    assert.equal(page.value.rules.length, 1);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
