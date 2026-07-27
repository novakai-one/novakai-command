// tests/layout.test.ts — SHL-002/003: layout is data, persisted via the
// foundation contract; restart restores it exactly (round-trip).
// M4: layout ops return typed Results — tests unwrap them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeShellPersistence } from '../contract/persistence.node.js';
import { getLayout, getLayoutVersioned, setLayout } from '../contract/layout.js';
import { LAYOUT_MAIN_ID } from '../contract/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-layout-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const compose = () => composeShellPersistence({ root, principal: 'person_test' });

describe('layout persistence (SHL-003)', () => {
  it('first boot materialises the default layout_main record', async () => {
    const res = await getLayout(compose().layoutDriver);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const layout = res.value;
    expect(layout.id).toBe(LAYOUT_MAIN_ID);
    expect(layout.kind).toBe('layout');
    expect(layout.rail.side).toBe('left');
    expect(layout.inspector.collapsed).toBe(true);
  });

  it('round-trips a full layout-change drill across a fresh composition (restart)', async () => {
    // Drill (SHL-002): rail left→right, resize rail, collapse inspector... settings edits only.
    const before = await getLayoutVersioned(compose().layoutDriver);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    await setLayout(compose().layoutDriver, {
      rail: { ...before.value.record.rail, side: 'right', width: 300, collapsed: false },
      inspector: { width: 280, collapsed: false },
      composer: { height: 180 },
    });

    // "Restart": a brand-new composition against the same root reads the store.
    const restored = await getLayout(compose().layoutDriver);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.rail.side).toBe('right');
    expect(restored.value.rail.width).toBe(300);
    expect(restored.value.inspector.width).toBe(280);
    expect(restored.value.inspector.collapsed).toBe(false);
    expect(restored.value.composer.height).toBe(180);
  });

  it('partial patches merge — untouched panels keep their values', async () => {
    await getLayoutVersioned(compose().layoutDriver);
    await setLayout(compose().layoutDriver, { composer: { height: 200 } });
    const after = await getLayout(compose().layoutDriver);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.composer.height).toBe(200);
    expect(after.value.rail.width).toBe(264); // default preserved
  });

  it('collapsing and re-expanding the rail persists both directions', async () => {
    await getLayoutVersioned(compose().layoutDriver);
    const collapsed = await setLayout(compose().layoutDriver, { rail: { side: 'left', width: 264, collapsed: true, order: ['messaging'] } });
    expect(collapsed.ok).toBe(true);
    if (collapsed.ok) expect(collapsed.value.record.rail.collapsed).toBe(true);
    const expanded = await setLayout(compose().layoutDriver, { rail: { side: 'left', width: 264, collapsed: false, order: ['messaging'] } });
    expect(expanded.ok).toBe(true);
    if (expanded.ok) expect(expanded.value.record.rail.collapsed).toBe(false);
    const restored = await getLayout(compose().layoutDriver);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.rail.collapsed).toBe(false);
  });
});
