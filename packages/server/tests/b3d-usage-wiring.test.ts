import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mintClientOpId, mintTraceCorrelationId, type B3Result,
} from '@novakai/foundation/contract';
import type { AgentRunView } from '../../agent-runtime/contract/index.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { connectRuntime } from '../core/b3/client.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { sanitizeCwd } from '../core/supervision/usage.js';
import { chatRole } from './governed-role.js';
import type { AgentRunUsage, AgentUsageSummary } from '../../supervision/contract/index.js';

const PRINCIPAL = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

function runNvk(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'nvk.mjs'), ...args], {
    cwd: repoRoot,
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    child.on('close', (code) => { resolve({ code, out }); });
  });
}

test('the live composition projects durable Agents evidence into Run views after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-usage-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  let runId = '';
  try {
    const client = await connectRuntime({ root, port: host.port, token: host.token });
    try {
      const role = unwrap(await client.call<{ id: string }>(
        'b3.agent.createRole', chatRole('usage-live-wire'), mintClientOpId(),
      ), 'create role');
      const spawned = unwrap(await client.call<AgentRunView>('b3.agent.spawn', {
        roleProfileId: role.id,
        displayName: 'Usage Wire',
        workingDirectory: root,
      }, mintClientOpId()), 'spawn');
      runId = spawned.run.id;
      assert.equal(spawned.usage.inputTokens.quality, 'unavailable');
      assert.equal(spawned.usage.inputTokens.value, undefined);
      const missingCli = await runNvk([
        'agent', 'usage', spawned.run.id,
        '--root', root, '--port', String(host.port),
      ]);
      assert.equal(missingCli.code, 0, missingCli.out);
      assert.equal(
        missingCli.out.includes('— input tokens (unavailable: no-provider-usage-evidence)'),
        true,
        missingCli.out,
      );

      const recorded = await host.runtime.usageEvidence.recordProviderUsageEvidence({
        principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
        clientOpId: mintClientOpId(),
        traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      }, {
        providerSessionId: spawned.provider.providerSessionId,
        providerConversationId: null,
        observedAt: '2026-08-03T03:00:00.000Z' as never,
        source: 'transcript-derived:provider-total',
        sourceCursor: 'line:42',
        measurement: {
          quality: 'measured',
          inputTokens: 500,
          outputTokens: 75,
          cachedInputTokens: 100,
          costMicros: 90_000,
          providerTurns: 3,
          limitations: [],
          evidenceDigest: 'sha256:live-wire-usage',
        },
      });
      assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);

      const moved = unwrap(await host.runtime.runs.getAgentRun(PRINCIPAL, spawned.run.id), 'view');
      assert.equal(moved.usage.inputTokens.value, 500);
      assert.equal(moved.usage.outputTokens.quality, 'measured');

      const runUsage = unwrap(await client.call<AgentRunUsage>(
        'b3.supervision.getRunUsage', { agentRunId: spawned.run.id },
      ), 'wire Run usage');
      assert.equal(runUsage.inputTokens.value, 500);
      const agentUsage = unwrap(await client.call<AgentUsageSummary>(
        'b3.supervision.getAgentUsage', { agentId: spawned.agent.agentId },
      ), 'wire Agent usage');
      assert.equal(agentUsage.aggregate.outputTokens.value, 75);

      const where = ['--root', root, '--port', String(host.port), '--json'];
      const usageCli = await runNvk(['agent', 'usage', spawned.run.id, ...where]);
      assert.equal(usageCli.code, 0, usageCli.out);
      assert.equal(JSON.parse(usageCli.out).value.inputTokens.value, 500);
      for (const verb of ['inspect', 'list'] as const) {
        const args = verb === 'inspect'
          ? ['agent', verb, spawned.run.id, ...where]
          : ['agent', verb, ...where];
        const seen = await runNvk(args);
        assert.equal(seen.code, 0, seen.out);
        assert.equal(seen.out.includes('"inputTokens"'), true, seen.out);
      }

      const events = unwrap(await host.runtime.runs.readRunEvents(PRINCIPAL, {}), 'events');
      const committed = events.events.find(
        (event) => event.kind === 'agent.provider-usage-evidence.committed',
      );
      assert.equal(committed?.sourceOwner, 'agents');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }

  const restarted = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const rebuilt = unwrap(
      await restarted.runtime.runs.getAgentRun(PRINCIPAL, runId as never),
      'rebuilt view',
    );
    assert.equal(rebuilt.usage.inputTokens.value, 500);
    assert.equal(rebuilt.usage.observedAt, '2026-08-03T03:00:00.000Z');
    assert.equal(rebuilt.usage.final, true);
  } finally {
    await restarted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the live composition estimates current token usage from the provider transcript', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-transcript-usage-'));
  const providerHome = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-provider-home-'));
  const host = await startRuntimeHost({
    root,
    providerHome,
    port: 0,
    ptyHost: createFakePtyHost(),
    providers: createFakeProviderAdapters(),
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await client.call<{ id: string }>(
      'b3.agent.createRole', chatRole('usage-transcript-wire'), mintClientOpId(),
    ), 'create role');
    const spawned = unwrap(await client.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Transcript Usage Wire',
      workingDirectory: root,
    }, mintClientOpId()), 'spawn');
    const session = unwrap(await host.runtime.agents.getProviderSession(
      PRINCIPAL,
      spawned.provider.providerSessionId,
    ), 'provider session');
    assert.equal(session.provider, 'claude');
    assert.notEqual(session.providerConversationId, null);
    const transcriptDir = path.join(
      providerHome,
      '.claude',
      'projects',
      sanitizeCwd(root),
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(path.join(transcriptDir, `${session.providerConversationId!}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-08-03T03:30:00.000Z',
        message: {
          id: 'msg_usage_1',
          usage: {
            input_tokens: 240,
            output_tokens: 60,
            cache_read_input_tokens: 20,
          },
        },
      })}\n`);

    const usage = unwrap(await host.runtime.supervision.getRunUsage(
      PRINCIPAL,
      spawned.run.id,
    ), 'transcript usage');
    assert.equal(usage.inputTokens.quality, 'estimated');
    assert.equal(usage.inputTokens.value, 240);
    assert.equal(usage.outputTokens.value, 60);
    assert.equal(usage.cachedInputTokens.value, 20);
    assert.equal(usage.costMicros.quality, 'unavailable');
    assert.equal(usage.costMicros.value, undefined);
    assert.equal(usage.providerTurns.quality, 'unavailable');
    assert.equal(usage.observedAt, '2026-08-03T03:30:00.000Z');
  } finally {
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(providerHome, { recursive: true, force: true });
  }
});
