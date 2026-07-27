// tests/presence-agents.test.ts — SHL-006/007 integration proof:
// REAL packages/agents agentEvent stream → shell PresenceTracker snapshot →
// WS bridge broadcast → client-side PresenceTracker (what the UI subscribes
// to) → the same state transitions. No terminal runtime: providers resolve to
// the mock adapter (AGT-001 seam identical), events still flow for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  composeAgents, createAgentsContract, mockOf,
} from '../../agents/contract/index.js';
import { PresenceTracker } from '../contract/presence.js';
import type { AgentEvent } from '../contract/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-presence-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const mintOpId = () => `op_${randomUUID()}` as never;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('agents → presence → bridge → UI state (SHL-006/007)', () => {
  it('agentEvent stream drives identical presence snapshots on both sides of a WS bridge', async () => {
    // node side (mirrors demo/bridge.ts wiring)
    const ctx = composeAgents({ root, principal: 'person_test' });
    const agents = createAgentsContract(ctx);
    const mock = mockOf(ctx);
    expect(mock).not.toBeNull();

    const serverTracker = new PresenceTracker();
    serverTracker.attach({ subscribeAgentEvents: (h) => agents.subscribeAgentEvents(h as never) });

    // bridge hop: real WebSocket, same frame shape as the demo bridge
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.on('listening', r));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', (ws) => {
      const unsub = agents.subscribeAgentEvents((e) => {
        ws.send(JSON.stringify({ type: 'event', name: 'presence', data: e }));
      });
      ws.on('close', unsub);
    });

    // browser side (mirrors demo/bridgeClient.ts → UI PresenceTracker)
    const clientTracker = new PresenceTracker();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'event' && frame.name === 'presence') {
        clientTracker.apply(frame.data as AgentEvent);
      }
    });
    await new Promise<void>((r) => ws.on('open', r));
    await waitFor(() => wss.clients.size === 1, 'bridge client connected');

    // define + spawn (mock provider — no PTY, same seam)
    const def = await agents.defineAgent(
      { displayName: 'Itest', provider: 'mock', model: 'mock-model', hooks: [], status: 'defined', permissionLevel: 'private' },
      mintOpId(),
    );
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    const agentId = def.value.id;

    expect(serverTracker.get(agentId).state).toBe('offline');
    const spawn = await agents.spawnAgent(agentId as never);
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;
    const sessionId = spawn.value.sessionId;

    // spawned/online published synchronously by spawnAgent
    expect(serverTracker.get(agentId).state).toBe('online');
    await waitFor(() => clientTracker.get(agentId).state === 'online', 'client online');

    // activity → typing state on both sides
    mock!.__emit(sessionId, {
      type: 'activity', sessionId, at: new Date().toISOString(), activity: 'typing a reply',
    });
    expect(serverTracker.get(agentId)).toMatchObject({ state: 'active', activity: 'typing a reply' });
    await waitFor(
      () => clientTracker.get(agentId).state === 'active'
        && clientTracker.get(agentId).activity === 'typing a reply',
      'client active w/ activity line',
    );

    // close → offline(closed) on both sides
    expect(agents.closeSession(sessionId as never)).toBe(true);
    await waitFor(() => serverTracker.get(agentId).state === 'offline', 'server offline');
    await waitFor(() => clientTracker.get(agentId).state === 'offline', 'client offline');

    ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
