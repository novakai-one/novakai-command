// A5-04 at the CLI: `--role <name>` is resolved BY THE OWNER.
//
// `roleIdFor` used to pull every role profile across the wire with
// `b3.agent.getRoles` and pick one itself:
//
//     roles.filter(role => role.name === given && role.status === 'active')
//
// That is the one thing A5-04 forbids — "the query never chooses" — and the
// client-side spelling was not merely inelegant, it answered wrongly:
//
//   * a retired role was INVISIBLE, so the CLI said "no active role is named
//     builder" when there is one and it is retired. The launch plan already
//     refuses a retired role BY NAME, which is the answer that tells an
//     operator what actually happened;
//   * when two profiles shared a name and one was retired, the filter QUIETLY
//     PICKED the live one — the CLI choosing, on the operator's behalf, between
//     two roles they had given one name to;
//   * a name that names nothing exited 3 (`RoleNotAllowed`, a permission
//     answer) where A5-04 rules `ValidationFailed`, exit 2. "You may not" and
//     "that is not a name I know" are different sentences.
//
// Everything here runs against a LIVE Runtime, because the observable that
// matters is which side produced the refusal — and that is only visible in the
// error the owner mints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { connectRuntime } from '../core/b3/client.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { chatRole } from './governed-role.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[], where: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args, ...where], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly ok?: boolean;
  readonly value?: { readonly id?: string; readonly name?: string; readonly status?: string };
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: {
      readonly roleProfileId?: string;
      readonly issues?: ReadonlyArray<{ readonly path?: string; readonly message?: string }>;
    };
  };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

const candidatesIn = (envelope: Envelope): readonly string[] =>
  (envelope.error?.details?.issues ?? [])
    .filter((issue) => (issue.path ?? '').startsWith('candidates'))
    .map((issue) => issue.message ?? '');

interface Rig {
  readonly where: readonly string[];
  readonly root: string;
  readonly port: number;
  define(role: Record<string, unknown>): Promise<string>;
}

async function withRuntime(work: (rig: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-role-name-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    let defined = 0;
    await work({
      where,
      root,
      port: host.port,
      async define(role) {
        defined += 1;
        const file = path.join(root, `role-${String(defined)}.json`);
        writeFileSync(file, JSON.stringify(role), 'utf8');
        const created = await runNvk(['agent', 'define-role', '--file', file], where);
        assert.equal(created.code, 0, `define-role failed: ${created.out}`);
        return envelopeOf(created).value?.id ?? '';
      },
    });
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const spawnWith = (role: string, where: readonly string[]): Promise<CliRun> =>
  runNvk(['agent', 'spawn', '--role', role, '--name', 'Nova', '--cwd', '.'], where);

test('a name that names nothing is ValidationFailed — exit 2, not a permission answer', async () => {
  await withRuntime(async (rig) => {
    await rig.define(chatRole('builder'));
    const spawned = await spawnWith('nobody', rig.where);
    const envelope = envelopeOf(spawned);
    assert.equal(envelope.error?.code, 'ValidationFailed',
      `the CLI answered with its own verdict: ${spawned.out}`);
    assert.equal(spawned.code, 2, `exit drifted from the ruled table: ${spawned.out}`);
    assert.equal(envelope.error?.details?.issues?.[0]?.path, 'displayName');
  });
});

test('a retired role resolves, and the LAUNCH POLICY refuses it by name', async () => {
  await withRuntime(async (rig) => {
    const retiredId = await rig.define({ ...chatRole('archivist'), status: 'retired' });
    const spawned = await spawnWith('archivist', rig.where);
    const envelope = envelopeOf(spawned);
    // Still refused — but by the owner that knows WHY, with the profile's real
    // id in hand. The client-side filter answered `no active role is named
    // "archivist"` and put the operator's typed NAME where an id belongs.
    assert.equal(envelope.error?.code, 'RoleNotAllowed', spawned.out);
    assert.match(envelope.error?.message ?? '', /retired/,
      `the refusal did not say the role is retired: ${spawned.out}`);
    assert.equal(envelope.error?.details?.roleProfileId, retiredId,
      'the refusal named something other than the resolved profile');
  });
});

test('two roles with one name refuse the spawn and name EVERY candidate', async () => {
  // The case the client-side filter got silently wrong: with one profile live
  // and one retired it chose the live one and spawned. Nobody was ever told.
  await withRuntime(async (rig) => {
    const live = await rig.define(chatRole('builder'));
    const retired = await rig.define({ ...chatRole('builder'), status: 'retired' });
    const spawned = await spawnWith('builder', rig.where);
    const envelope = envelopeOf(spawned);
    assert.equal(envelope.error?.code, 'ValidationFailed',
      `the CLI chose between two profiles: ${spawned.out}`);
    assert.equal(spawned.code, 2);
    assert.deepEqual([...candidatesIn(envelope)].sort(), [live, retired].sort());
  });
});

test('an id argument is still taken as an id — no lookup, no name rules', async () => {
  await withRuntime(async (rig) => {
    const roleId = await rig.define(chatRole('builder'));
    const spawned = await spawnWith(roleId, rig.where);
    assert.equal(spawned.code, 0, `spawning by id was refused: ${spawned.out}`);
    assert.equal(envelopeOf(spawned).command, 'agent.spawn');
  });
});

test('the exact name still spawns — resolution moved, it did not break', async () => {
  await withRuntime(async (rig) => {
    await rig.define(chatRole('builder'));
    await rig.define(chatRole('auditor'));
    const spawned = await spawnWith('builder', rig.where);
    assert.equal(spawned.code, 0, `spawning by name was refused: ${spawned.out}`);
    assert.equal(envelopeOf(spawned).ok, true);
  });
});

test('`b3.agent.resolveRoleByName` answers the profile itself, not a list', async () => {
  // The wire method A5-04 adds (§16.2), driven on the v1 frame. It hands back
  // ONE `AgentRoleProfile`; a caller never sees the profiles it did not ask
  // about, which is the other half of moving the match to the owner.
  await withRuntime(async (rig) => {
    const builder = await rig.define(chatRole('builder'));
    await rig.define(chatRole('auditor'));
    const client = await connectRuntime({ root: rig.root, port: rig.port });
    try {
      const resolved = await client.call<{ id: string; name: string }>(
        'b3.agent.resolveRoleByName', { displayName: 'builder' },
      );
      assert.equal(resolved.ok, true, `resolveRoleByName failed: ${JSON.stringify(resolved)}`);
      if (!resolved.ok) return;
      assert.equal(resolved.value.id, builder);
      assert.equal(resolved.value.name, 'builder');
    } finally {
      client.close();
    }
  });
});
