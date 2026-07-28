// tests/glitchfixes.test.ts — browser-drive glitch fixes G1/G2.
// G1: optimistic echo + server broadcast must not render a message twice.
// G2: a new inspect target must auto-open a collapsed inspector pane.
// G3 (unique person per spawned agent) and G4 (idempotent seeding) moved to
// packages/server with the code they guard: B1a replaced the demo's person
// pool with DEC-B1-8 person-per-agent and the demo seeding with config
// materialization. See packages/server/tests/boot.test.ts.
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../contract/index.js';
import { dedupeById, appendDedup } from '../ui/screens/messaging/messageList.js';
import { shouldAutoOpenInspector } from '../ui/frame/inspectorVisibility.js';

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
