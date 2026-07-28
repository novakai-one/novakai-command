// tests/glitchfixes.test.ts — browser-drive glitch fixes G1/G2/G3/G4.
// G1: optimistic echo + server broadcast must not render a message twice.
// G2: a new inspect target must auto-open a collapsed inspector pane.
// G3: each spawned mock agent needs a UNIQUE messaging person (separate threads).
// G4: demo agent seeding must be idempotent across bridge boots.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../contract/index.js';
import { dedupeById, appendDedup } from '../ui/screens/messaging/messageList.js';
import { shouldAutoOpenInspector } from '../ui/frame/inspectorVisibility.js';
import {
  MOCK_POOL_SIZE, mockAgentPersonId, mockAgentToken, mockAgentPrincipals, MockPersonPool,
} from '../demo/mockPersons.js';
import { ensureAgent, type EnsureAgentsContract } from '../demo/ensureAgent.js';
import * as messaging from '../../messaging/public/index.js';
import type { PersonId } from '../../messaging/public/index.js';

const msg = (id: string, text = id): ChatMessage => ({
  id, conversationId: 'conv_1', senderId: 'me', text, createdAt: '2026-07-28T00:00:00Z',
});

describe('G1 — message dedup (optimistic echo vs server broadcast)', () => {
  it('appending the broadcast when the optimistic replacement already landed → no duplicate', () => {
    // Live order: broadcast 'message' arrives first, then sendMessage resolves
    // and the pending bubble is REPLACED with the same id.
    let list: ChatMessage[] = [msg('pending_1')];
    list = appendDedup(list, msg('msg_srv1'));            // broadcast appended
    list = list.map((m) => (m.id === 'pending_1' ? msg('msg_srv1') : m)); // optimistic → real id
    list = dedupeById(list);
    expect(list.map((m) => m.id)).toEqual(['msg_srv1']);
  });

  it('appending the same broadcast twice (retry/re-deliver) → still one entry', () => {
    let list: ChatMessage[] = [];
    list = appendDedup(list, msg('msg_srv1'));
    list = appendDedup(list, msg('msg_srv1'));
    expect(list).toHaveLength(1);
  });

  it('dedupeById keeps first occurrence order', () => {
    const out = dedupeById([msg('a'), msg('b'), msg('a'), msg('c'), msg('b')]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('G2 — inspector auto-open on new inspect target', () => {
  const contentA = { title: 'A', body: null };
  const contentB = { title: 'B', body: null };
  it('collapsed pane + NEW inspect content → opens', () => {
    expect(shouldAutoOpenInspector(null, contentA, true)).toBe(true);
  });
  it('collapsed pane + a DIFFERENT message clicked after a manual close → re-opens', () => {
    expect(shouldAutoOpenInspector(contentA, contentB, true)).toBe(true);
  });
  it('open pane → no forced re-open', () => {
    expect(shouldAutoOpenInspector(null, contentA, false)).toBe(false);
  });
  it('manual close, SAME content object → stays closed (no fight with the user)', () => {
    expect(shouldAutoOpenInspector(contentA, contentA, true)).toBe(false);
  });
  it('content cleared → nothing to open', () => {
    expect(shouldAutoOpenInspector(contentA, null, true)).toBe(false);
  });
});

describe('G3 — unique person per spawned mock agent', () => {
  it('pool hands out unique provisioned persons and exhausts cleanly', () => {
    const pool = new MockPersonPool();
    const assigned = new Set<string>();
    for (let i = 0; i < MOCK_POOL_SIZE; i++) {
      const a = pool.assign();
      expect(a).not.toBeNull();
      expect(assigned.has(a!.personId)).toBe(false);
      assigned.add(a!.personId);
    }
    expect(pool.assign()).toBeNull(); // exhausted — typed null, never a shared fallback
  });

  it('provisioned principals are unique token/person pairs', () => {
    const p = mockAgentPrincipals();
    expect(p).toHaveLength(MOCK_POOL_SIZE);
    expect(new Set(p.map((x) => x.token)).size).toBe(MOCK_POOL_SIZE);
    expect(new Set(p.map((x) => x.personId)).size).toBe(MOCK_POOL_SIZE);
    expect(p[0]).toEqual({ token: mockAgentToken(0), personId: mockAgentPersonId(0), roles: ['Worker'] });
  });

  it('REAL messaging: two mock-agent persons give Chris two DISTINCT threads (the G3 regression)', async () => {
    const clock = messaging.createSystemClock();
    const store = await messaging.openJsonlStore(clock, {
      path: path.join(mkdtempSync(path.join(tmpdir(), 'nvk-g3-')), 'messaging.jsonl'),
    });
    const embedded = messaging.createEmbeddedMessaging({
      clock,
      store,
      authority: {
        principals: [
          { token: 't-chris', personId: 'person_chris' as PersonId, roles: ['Human'] },
          ...mockAgentPrincipals().slice(0, 2).map((p) => ({ ...p, personId: p.personId as PersonId })),
        ],
        roleGrants: messaging.DEFAULT_ROLE_GRANTS,
      },
    });
    await embedded.start();
    const auth = await embedded.authenticate({ token: 't-chris' });
    if (auth.kind !== 'authenticated') throw new Error('auth failed');
    // Each mock person opens its own door to Chris (DEC-14: per-principal policy).
    for (const token of [mockAgentToken(0), mockAgentToken(1)]) {
      const a = await embedded.authenticate({ token });
      if (a.kind !== 'authenticated') throw new Error('agent auth failed');
      await a.session.setContactPolicy({ allowlist: ['person_chris'], defaultRule: 'deny' });
    }
    const r0 = await auth.session.sendMessage({
      address: `person:${mockAgentPersonId(0)}`, body: { text: 'hi mock 0' },
      priority: 'normal', clientMessageId: 'cmsg_g3_0',
    });
    const r1 = await auth.session.sendMessage({
      address: `person:${mockAgentPersonId(1)}`, body: { text: 'hi mock 1' },
      priority: 'normal', clientMessageId: 'cmsg_g3_1',
    });
    if (r0.kind !== 'ok' || r1.kind !== 'ok') throw new Error('send failed');
    expect(r0.value.threadId).not.toBe(r1.value.threadId); // separate threads — no cross-talk
  });
});

describe('G4 — idempotent demo agent seeding', () => {
  const stubAgents = () => {
    const state = {
      items: [] as Array<{ id: string; displayName: string; provider: string; status: string }>,
      defines: 0,
    };
    const agents: EnsureAgentsContract = {
      async listAgents() { return { ok: true as const, value: { items: state.items } }; },
      async defineAgent(input) {
        state.defines += 1;
        const a = { id: `agent_${state.items.length}`, displayName: input.displayName, provider: input.provider, status: 'defined' };
        state.items.push(a);
        return { ok: true as const, value: { id: a.id } };
      },
    };
    return { agents, state };
  };

  it('boot twice → Kimi and Fable defined ONCE, ids reused', async () => {
    const { agents, state } = stubAgents();
    let seq = 0;
    const mint = () => `op_test-${seq += 1}`;
    // boot 1
    const kimi1 = await ensureAgent(agents, 'Kimi', 'mock', mint);
    const fable1 = await ensureAgent(agents, 'Fable', 'mock', mint);
    // boot 2 (same persisted registry)
    const kimi2 = await ensureAgent(agents, 'Kimi', 'mock', mint);
    const fable2 = await ensureAgent(agents, 'Fable', 'mock', mint);
    expect(kimi2).toBe(kimi1);
    expect(fable2).toBe(fable1);
    expect(state.defines).toBe(2); // two defines total, not four
    expect(state.items.filter((a) => a.displayName === 'Kimi')).toHaveLength(1);
    expect(state.items.filter((a) => a.displayName === 'Fable')).toHaveLength(1);
  });

  it('same name on a DIFFERENT provider is not reused (mock Kimi ≠ real Kimi)', async () => {
    const { agents, state } = stubAgents();
    let seq = 0;
    const mint = () => `op_test-${seq += 1}`;
    await ensureAgent(agents, 'Kimi', 'mock', mint);
    const real = await ensureAgent(agents, 'Kimi', 'kimi', mint);
    expect(state.defines).toBe(2);
    expect(real).not.toBe('agent_0');
  });
});
