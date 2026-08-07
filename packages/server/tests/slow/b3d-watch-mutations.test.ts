// Lane B — the published watcher mutations through the existing nvk-ws table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3ok } from '@novakai/foundation/contract';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { createFakePtyHost, type FakePty } from '../../../terminal/adapters/pty-host/fake.js';
import { composeSupervision } from '../../../supervision/public/index.js';
import { buildB3SupervisionMethods } from '../../core/b3/supervision-methods.js';
import { clientOpIdFrom } from '../../core/b3/cli-shared.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime } from '../../core/b3/client.js';
import type { MethodTable } from '../../contract/protocol.js';
import { governedRole, governedTokens } from '../governed-role.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const HUMAN = {
  id: 'person_chris' as never,
  kind: 'human' as const,
  verifiedScopes: [],
};
const AGENT_RECIPIENT = 'agent_123e4567-e89b-42d3-a456-426614174000';

function call(table: MethodTable, method: string, payload: unknown) {
  const handler = table[method];
  assert.notEqual(handler, undefined, `${method} is not on the published wire`);
  return handler!({
    contractVersion: 1,
    clientOpId: 'op_123e4567-e89b-42d3-a456-426614174020',
    payload,
  } as never) as Promise<{
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: { readonly code: string };
  }>;
}

function publishedDriftPayload(
  intervalMs = 300_000,
  staleAfterIntervals = 2,
  escalateAfterConsecutive = 3,
) {
  return {
    subject: {
      kind: 'agent-run',
      agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
    },
    condition: {
      kind: 'activity-drift',
      intervalMs,
      staleAfterIntervals,
      escalateAfterConsecutive,
    },
    recipient: { kind: 'agent', agentId: AGENT_RECIPIENT },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    driftPolicy: {
      mode: 'cheap-first',
      freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      replyWindowMs: intervalMs,
      statusPrompt: 'Status check: reply with one line — what are you working on right now?',
    },
  };
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

function answerGate(ptyHost: ReturnType<typeof createFakePtyHost>): void {
  const known = new Set<FakePty>();
  const timer = setInterval(() => {
    for (const pty of ptyHost.started) {
      if (known.has(pty)) continue;
      known.add(pty);
      pty.onTurn((turn) => {
        if (turn.includes('do NOT begin it yet')) {
          pty.emit(`SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}\n`);
        }
      });
    }
  }, 5);
  timer.unref();
}

test('watcher mutations accept deterministic UUIDv5 ClientOpIds', () => {
  const clientOpId = 'op_123e4567-e89b-52d3-a456-426614174020';
  const parsed = clientOpIdFrom({
    json: true,
    positional: [],
    value: (name) => name === 'client-op-id' ? clientOpId : undefined,
    values: (name) => name === 'client-op-id' ? [clientOpId] : [],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value, clientOpId);
});

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

test('b3.supervision.createWatch accepts the published activity-drift policy and arms it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-drift-mutation-'));
  try {
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(7 as never) },
    });
    const table = buildB3SupervisionMethods({
      supervision,
      principalFor: () => ({
        ...HUMAN,
        verifiedScopes: ['supervision:watch:start-turn' as never],
      }),
      activityGenerationFor: async () => 7 as never,
    });
    const created = await call(
      table,
      'b3.supervision.createWatch',
      publishedDriftPayload(),
    );
    assert.equal(created.ok, true, JSON.stringify(created));

    const listed = await call(table, 'b3.supervision.listWatchers', { limit: 50 });
    assert.equal(listed.ok, true);
    const value = listed.value as {
      readonly deadlines: readonly { readonly id: string; readonly activityGeneration: number }[];
    };
    assert.equal(value.deadlines.length, 1);
    assert.equal(typeof value.deadlines[0]!.id, 'string');
    assert.match(value.deadlines[0]!.id, /^watchDeadline_[a-z2-7]{52}$/);
    assert.equal(value.deadlines[0]!.activityGeneration, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('b3.supervision.createWatch names noncanonical drift constants WatchRuleInvalid', async () => {
  const table = buildB3SupervisionMethods({
    supervision: {
      createWatchRule: async () => { throw new Error('invalid input reached the core'); },
    } as never,
    principalFor: () => HUMAN,
    activityGenerationFor: async () => 1 as never,
  });
  const stale = await call(
    table,
    'b3.supervision.createWatch',
    publishedDriftPayload(300_000, 3, 3),
  );
  const escalate = await call(
    table,
    'b3.supervision.createWatch',
    publishedDriftPayload(300_000, 2, 4),
  );

  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'WatchRuleInvalid');
  assert.equal(escalate.ok, false);
  assert.equal(escalate.error?.code, 'WatchRuleInvalid');
});

test('b3.supervision.createWatch enforces drift-policy presence by condition kind', async () => {
  const table = buildB3SupervisionMethods({
    supervision: {
      createWatchRule: async () => { throw new Error('invalid input reached the core'); },
    } as never,
    principalFor: () => HUMAN,
    activityGenerationFor: async () => 1 as never,
  });
  const { driftPolicy, ...missingPolicy } = publishedDriftPayload();
  const strayPolicy = {
    ...missingPolicy,
    condition: { kind: 'run-final' },
    driftPolicy,
  };

  const missing = await call(table, 'b3.supervision.createWatch', missingPolicy);
  const stray = await call(table, 'b3.supervision.createWatch', strayPolicy);

  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'WatchRuleInvalid');
  assert.equal(stray.ok, false);
  assert.equal(stray.error?.code, 'WatchRuleInvalid');
});

test('b3.supervision.createWatch accepts both inclusive drift timing endpoints', async () => {
  const table = buildB3SupervisionMethods({
    supervision: {
      createWatchRule: async (_context: unknown, input: unknown) => b3ok(input as never),
    } as never,
    principalFor: () => ({
      ...HUMAN,
      verifiedScopes: ['supervision:watch:start-turn' as never],
    }),
    activityGenerationFor: async () => 1 as never,
  });

  const low = await call(table, 'b3.supervision.createWatch', publishedDriftPayload(300_000));
  const high = await call(table, 'b3.supervision.createWatch', publishedDriftPayload(600_000));

  assert.equal(low.ok, true, JSON.stringify(low));
  assert.equal(high.ok, true, JSON.stringify(high));
});

test('b3.supervision.resetDrift carries the exact episode/version fence', async () => {
  let received: unknown;
  const table = buildB3SupervisionMethods({
    supervision: {
      resetDriftEpisode: async (_context: unknown, input: unknown) => {
        received = input;
        return b3ok({ id: 'watchDeadline_' + 'a'.repeat(52) } as never);
      },
    } as never,
    principalFor: () => HUMAN,
    activityGenerationFor: async () => 1 as never,
  });
  const payload = {
    watchDeadlineId: 'watchDeadline_' + 'a'.repeat(52),
    expectedRecordVersion: 7,
    expectedEpisodeId: 'driftEpisode_' + 'b'.repeat(52),
    reason: 'operator reviewed the escalation',
  };
  const reset = await call(table, 'b3.supervision.resetDrift', payload);
  assert.equal(reset.ok, true);
  assert.deepEqual(received, payload);
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
      '--notify', AGENT_RECIPIENT,
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

test('nvk watch update replaces one watcher behind its current version fence', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-watch-update-'));
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
      readonly value: { readonly id: string; readonly recordVersion: number };
    };

    // A5-02: the fence is the version the CALLER holds — here, the one the
    // create just returned. The CLI no longer fetches it, so this is the first
    // version of this test where the word "fence" in its name is true.
    const updated = await runNvk([
      'watch', 'update', created.value.id,
      '--delivery', 'next-turn-context',
      '--expect-version', String(created.value.recordVersion),
      ...where,
    ]);
    assert.equal(updated.code, 0, updated.out);
    const replacement = JSON.parse(updated.out) as {
      readonly value: { readonly deliveryMode: string; readonly recordVersion: number };
    };
    assert.equal(replacement.value.deliveryMode, 'next-turn-context');
    assert.equal(replacement.value.recordVersion, 2);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('nvk watch remove retires its watcher instead of deleting it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-watch-remove-'));
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
      '--notify', AGENT_RECIPIENT,
      '--delivery', 'queue-only',
      ...where,
    ]);
    assert.equal(added.code, 0, added.out);
    const created = JSON.parse(added.out) as {
      readonly value: { readonly id: string; readonly recordVersion: number };
    };

    const removed = await runNvk(['watch', 'remove', created.value.id,
      '--expect-version', String(created.value.recordVersion), ...where]);
    assert.equal(removed.code, 0, removed.out);
    const retired = JSON.parse(removed.out) as {
      readonly value: { readonly id: string; readonly status: string };
    };
    assert.equal(retired.value.id, created.value.id);
    assert.equal(retired.value.status, 'retired');

    const listed = await runNvk(['watch', 'list', ...where]);
    const page = JSON.parse(listed.out) as {
      readonly value: { readonly rules: readonly { readonly status: string }[] };
    };
    assert.equal(page.value.rules[0]?.status, 'retired');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('nvk watch add arms activity drift from the live Run generation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-watch-drift-add-'));
  const ptyHost = createFakePtyHost({ echoInput: false, composer: true });
  answerGate(ptyHost);
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: createFakeProviderAdapters(),
    gateTimeoutMs: 5_000,
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  const where = ['--root', root, '--port', String(host.port), '--json'];
  try {
    const role = await client.call<{ readonly id: string }>('b3.agent.createRole', {
      ...governedRole('b3d-manual-drift'),
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [],
        parentNotificationMode: 'queue-only',
      },
    });
    assert.equal(role.ok, true, role.ok ? '' : role.error.message);
    if (!role.ok) return;
    const spawned = await client.call<{ readonly run: { readonly id: string } }>(
      'b3.agent.spawn', {
        roleProfileId: role.value.id,
        displayName: 'Drift subject',
        workingDirectory: tmpdir(),
        task: { kind: 'supervised', brief: 'Wait.' },
      },
    );
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const added = await runNvk([
      'watch', 'add',
      '--subject', spawned.value.run.id,
      '--when', 'activity-drift',
      '--notify', 'human',
      '--delivery', 'queue-only',
      ...where,
    ]);
    assert.equal(added.code, 0, added.out);
    const listed = await runNvk(['watch', 'list', ...where]);
    const page = JSON.parse(listed.out) as {
      readonly value: {
        readonly deadlines: readonly {
          readonly id: string; readonly state: string; readonly recordVersion: number;
        }[];
      };
    };
    assert.equal(page.value.deadlines[0]?.state, 'armed');

    const displayed = await runNvk([
      'watch', 'list', '--root', root, '--port', String(host.port),
    ]);
    assert.equal(displayed.code, 0, displayed.out);
    assert.match(
      displayed.out,
      /watchDeadline_[a-z2-7]{52}/,
      'the published operator listing hid the durable deadline identity',
    );

    // A5-02: the version and the reason are the OPERATOR's now. The version is
    // the one this test just read from the published listing, so the only thing
    // the owner can find wrong is the episode — which is the conflict this test
    // has always been about, and is now the ONLY thing it can be about.
    const reset = await runNvk([
      'watch', 'reset-drift', page.value.deadlines[0]!.id,
      '--expect-version', String(page.value.deadlines[0]!.recordVersion),
      '--expect-episode', 'driftEpisode_' + 'b'.repeat(52),
      '--reason', 'the agent was waiting on me, not drifting',
      ...where,
    ]);
    assert.equal(reset.code, 4, reset.out);
    const refused = JSON.parse(reset.out) as { readonly error: { readonly code: string } };
    assert.equal(refused.error.code, 'WatcherConflict');
  } finally {
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
