// Agents-API stall health + nudge route tests (mission_agent-stall-detection).
// Fake TerminalRuntime, real express — the missionSpawn.test.ts harness
// pattern. Run with `npx tsx src/backend/server/tests/agentsHealth.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { AgentsHub } from '../agents.js';
import type { AgentActivity, AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import { NUDGE_PROMPT } from '../../terminal/nudge/index.js';

// Rig-style env thresholds, read once at AgentsHub construction.
process.env.NVK_STALL_QUIET_MS = '300000';    // 5 min
process.env.NVK_STALL_STALLED_MS = '900000';  // 15 min

const NOW_MS = Date.now();

function agentInfo(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    agentId: 'agent_x', title: 'claude-1', provider: 'claude', sessionId: '',
    projectDir: 'project', cwd: '/tmp/project', status: 'running', createdAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

const quietAgent = agentInfo({ agentId: 'agent_quiet', title: 'quiet' });
const freshAgent = agentInfo({ agentId: 'agent_fresh', title: 'fresh' });
const exitedAgent = agentInfo({ agentId: 'agent_exited', title: 'done', status: 'exited' });
const kimiAgent = agentInfo({ agentId: 'agent_kimi', title: 'kimi-1', provider: 'kimi' });

const activities = new Map<string, AgentActivity>([
  ['agent_quiet', { lastOutputAtMs: NOW_MS - 10 * 60_000, trackedSinceMs: NOW_MS - 60 * 60_000 }],
  ['agent_fresh', { lastOutputAtMs: NOW_MS - 1_000, trackedSinceMs: NOW_MS - 60 * 60_000 }],
  ['agent_exited', { lastOutputAtMs: NOW_MS - 1_000, trackedSinceMs: NOW_MS - 60 * 60_000 }],
  ['agent_kimi', { lastOutputAtMs: NOW_MS - 1_000, trackedSinceMs: NOW_MS - 60 * 60_000 }],
]);

function makeTerminals(submitted: SubmitJob[]): TerminalRuntime {
  return {
    create: () => Promise.reject(new Error('unused')),
    write: () => true,
    submit: (submitJob) => { submitted.push(submitJob); return true; },
    resize: () => true, rename: () => true, kill: () => true, archive: () => true,
    snapshot: () => '',
    activity: (agentId) => activities.get(agentId) ?? null,
    list: () => [quietAgent, freshAgent, exitedAgent, kimiAgent],
    onData: () => {}, onExit: () => {}, onSession: () => {},
  };
}

interface Harness { base: string; submitted: SubmitJob[]; nudgesPath: string; close: () => void; }

function makeHarness(): Promise<Harness> {
  const submitted: SubmitJob[] = [];
  const nudgesPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-nudges-')), 'nudges.jsonl');
  const application = express();
  application.use(express.json());
  const agentsHub = new AgentsHub(new Set(), makeTerminals(submitted), undefined, undefined, nudgesPath);
  agentsHub.registerRoutes(application);
  return new Promise((resolve) => {
    const server: Server = application.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, submitted, nudgesPath, close: () => server.close() });
    });
  });
}

const harness = await makeHarness();

// --- T-API-HEALTH: list rows carry derived health ---------------------------

{
  const response = await fetch(`${harness.base}/api/agents`);
  const body = await response.json() as { agents: Array<AgentInfo & { health: { state: string } | null }> };
  const byId = new Map(body.agents.map((agent) => [agent.agentId, agent]));
  assert.equal(byId.get('agent_quiet')?.health?.state, 'quiet', '10min silent running agent → quiet');
  assert.equal(byId.get('agent_fresh')?.health?.state, 'ok', 'fresh output → ok');
  assert.equal(byId.get('agent_exited')?.health, null, 'exited agents have null health');
}

// --- T-API-HEALTH: dedicated health endpoint --------------------------------

{
  const response = await fetch(`${harness.base}/api/agents/agent_quiet/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as { agentId: string; status: string; health: { state: string; silentForMs: number } };
  assert.equal(body.agentId, 'agent_quiet');
  assert.equal(body.status, 'running');
  assert.equal(body.health.state, 'quiet');
  assert.ok(body.health.silentForMs >= 10 * 60_000, 'silentForMs reports the age');
  const missing = await fetch(`${harness.base}/api/agents/agent_ghost/health`);
  assert.equal(missing.status, 404, 'unknown agent → 404');
}

// --- T-API-NUDGE: happy path -------------------------------------------------

{
  const response = await fetch(`${harness.base}/api/agents/agent_quiet/nudge`, { method: 'POST' });
  assert.equal(response.status, 202);
  const body = await response.json() as { agentId: string; nudgeId: string; healthBefore: { state: string } };
  assert.match(body.nudgeId, /^nudge_/, 'nudge id minted');
  assert.equal(body.healthBefore.state, 'quiet', 'health before the nudge is reported');
  assert.equal(harness.submitted.length, 1, 'exactly one submit reached the terminal lane');
  const submitJob = harness.submitted[0]!;
  assert.equal(submitJob.agentId, 'agent_quiet');
  assert.equal(submitJob.messageId, body.nudgeId, 'submit is keyed by the nudge id');
  assert.equal(submitJob.text, NUDGE_PROMPT, 'the neutral prompt is typed verbatim');
  assert.equal(submitJob.settleMs, 900, 'tunnel-parity settle timing');
  assert.equal(submitJob.flushMs, undefined, 'claude gets no flush');
}

// --- T-API-NUDGE: fresh ids per nudge (harmless to healthy agents) ----------

{
  const response = await fetch(`${harness.base}/api/agents/agent_fresh/nudge`, { method: 'POST' });
  assert.equal(response.status, 202, 'a nudge to a healthy agent is accepted (harmless)');
  const body = await response.json() as { nudgeId: string };
  const again = await fetch(`${harness.base}/api/agents/agent_fresh/nudge`, { method: 'POST' });
  const secondBody = await again.json() as { nudgeId: string };
  assert.notEqual(body.nudgeId, secondBody.nudgeId, 'each nudge mints a fresh id');
}

// --- T-API-NUDGE: kimi flush parity ------------------------------------------

{
  await fetch(`${harness.base}/api/agents/agent_kimi/nudge`, { method: 'POST' });
  const submitJob = harness.submitted[harness.submitted.length - 1]!;
  assert.equal(submitJob.flushMs, 6000, 'kimi provider gets the flush \\r');
}

// --- T-API-NUDGE: rejections -------------------------------------------------

{
  const missing = await fetch(`${harness.base}/api/agents/agent_ghost/nudge`, { method: 'POST' });
  assert.equal(missing.status, 404, 'unknown agent → 404');
  const exited = await fetch(`${harness.base}/api/agents/agent_exited/nudge`, { method: 'POST' });
  assert.equal(exited.status, 409, 'exited agent → 409');
  const submitsBefore = harness.submitted.filter((submitJob) => submitJob.agentId === 'agent_exited').length;
  assert.equal(submitsBefore, 0, 'no submit for a rejected nudge');
}

// --- T-API-NUDGE: the action is recorded -------------------------------------

{
  assert.ok(existsSync(harness.nudgesPath), 'nudges.jsonl exists');
  const lines = readFileSync(harness.nudgesPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
    id: string; kind: string; ts: string; agentId: string; healthBefore: { state: string } | null;
  });
  assert.equal(lines.length, 4, 'one record per accepted nudge');
  const first = lines[0]!;
  assert.equal(first.kind, 'nudge', 'typed-block record');
  assert.match(first.id, /^nudge_/);
  assert.equal(first.agentId, 'agent_quiet');
  assert.equal(first.healthBefore?.state, 'quiet');
  assert.ok(!Number.isNaN(Date.parse(first.ts)), 'ts is ISO');
}

// --- D-N7-7: the slack-bridge health route -------------------------------------

{
  const bridgeStatePath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-bridge-health-')), 'state.json');
  process.env.NVK_SLACK_BRIDGE_STATE = bridgeStatePath;
  try {
    // 404 while the file is absent (the bridge never ran here).
    const missing = await fetch(`${harness.base}/api/agents/slack-bridge/health`);
    assert.equal(missing.status, 404, 'absent state file → 404');

    // 200 with the health block + cursor when the file is fresh.
    writeFileSync(bridgeStatePath, JSON.stringify({
      cursor: 42,
      roots: {}, agents: {},
      health: {
        updatedAt: new Date().toISOString(), appRetryCount: 0, slackRetryCount: 1,
        lastError: null, lastBridgedAt: new Date().toISOString(),
      },
    }));
    const fresh = await fetch(`${harness.base}/api/agents/slack-bridge/health`);
    assert.equal(fresh.status, 200, 'a fresh state file serves');
    const body = await fresh.json() as { cursor: number; health: { appRetryCount: number; slackRetryCount: number } };
    assert.equal(body.cursor, 42, 'the cursor rides along');
    assert.equal(body.health.slackRetryCount, 1, 'the health block is served verbatim');

    // 503 when updatedAt is stale (>5 min — bridge down or wedged).
    writeFileSync(bridgeStatePath, JSON.stringify({
      cursor: 42,
      health: { updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    }));
    const stale = await fetch(`${harness.base}/api/agents/slack-bridge/health`);
    assert.equal(stale.status, 503, 'a stale health block → 503');

    // F8: a non-ISO updatedAt is stale honestly, never 200-garbage.
    writeFileSync(bridgeStatePath, JSON.stringify({ cursor: 42, health: { updatedAt: 'not-a-date' } }));
    const garbage = await fetch(`${harness.base}/api/agents/slack-bridge/health`);
    assert.equal(garbage.status, 503, 'a non-ISO updatedAt → 503, never 200-garbage');
  } finally {
    delete process.env.NVK_SLACK_BRIDGE_STATE;
  }
}

harness.close();
console.log('PASS');
