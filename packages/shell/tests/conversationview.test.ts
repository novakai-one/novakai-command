// F1/DEC-S2-11 — conversationView: shell-owned pin/archive/title-override
// view state, persisted via the foundation scoped handle. Restart restores
// pin/archive; UI mutations carry clientOpId (retry = no duplicate).
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeShellPersistence } from '../contract/persistence.node.js';
import {
  setConversationView, getConversationView, listConversationViews,
} from '../contract/conversationView.js';
import { mintShellOpId } from '../contract/services.js';

const compose = (root: string) => composeShellPersistence({ root, principal: 'person_chris' });

describe('conversationView (F1, DEC-S2-11)', () => {
  it('setConversationView creates then CAS-updates pin/archive/titleOverride', async () => {
    const p = compose(mkdtempSync(path.join(tmpdir(), 'nvk-cv-')));
    const created = await setConversationView(p.conversationViewDriver, 'conv_a', { pinned: true }, mintShellOpId());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.record.pinned).toBe(true);
    expect(created.value.record.archived).toBe(false);
    expect(created.value.record.threadRef).toBeNull();

    const updated = await setConversationView(p.conversationViewDriver, 'conv_a', {
      archived: true, titleOverride: 'Renamed', threadRef: { kind: 'thread', id: 'thread_1' },
    }, mintShellOpId());
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.record.pinned).toBe(true); // preserved across patch
    expect(updated.value.record.archived).toBe(true);
    expect(updated.value.record.titleOverride).toBe('Renamed');
    expect(updated.value.record.threadRef).toEqual({ kind: 'thread', id: 'thread_1' });
    expect(updated.value.version).toBe(created.value.version + 1);
  });

  it('RESTART: a fresh persistence composition over the same root restores pin/archive', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nvk-cv-'));
    const before = compose(root);
    await setConversationView(before.conversationViewDriver, 'conv_kimi', { pinned: true }, mintShellOpId());
    await setConversationView(before.conversationViewDriver, 'conv_fable', { archived: true }, mintShellOpId());

    // process "restarts": brand-new composition, same root
    const after = compose(root);
    const kimi = await getConversationView(after.conversationViewDriver, 'conv_kimi');
    const fable = await getConversationView(after.conversationViewDriver, 'conv_fable');
    expect(kimi?.pinned).toBe(true);
    expect(kimi?.archived).toBe(false);
    expect(fable?.archived).toBe(true);
    const all = await listConversationViews(after.conversationViewDriver);
    expect(all.length).toBe(2);
  });

  it('RETRY with the same clientOpId → no duplicate object (R3-10 dedup)', async () => {
    const p = compose(mkdtempSync(path.join(tmpdir(), 'nvk-cv-')));
    const opId = mintShellOpId();
    const first = await setConversationView(p.conversationViewDriver, 'conv_x', { pinned: true }, opId);
    expect(first.ok).toBe(true);
    const retry = await setConversationView(p.conversationViewDriver, 'conv_x', { pinned: true }, opId);
    expect(retry.ok).toBe(true);
    const all = await listConversationViews(p.conversationViewDriver);
    expect(all.filter((v) => v.id === 'conv_x').length, 'one object, never a dup').toBe(1);
    const got = await p.conversationViewDriver.get('conv_x');
    expect(got?.version, 'no double-apply: still the first write').toBe(1);
  });
});
