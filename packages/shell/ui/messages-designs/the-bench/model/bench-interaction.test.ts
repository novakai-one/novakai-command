import { describe, expect, it, vi } from 'vitest';
import {
  buildFocusConversationCommand,
  buildRestoreViewportCommand,
  buildRevealNodeCommand,
  interpretBenchKey,
  resolveBenchZoomTier,
} from './bench-interaction';

describe('Bench interaction policy', () => {
  it('resolves the three semantic zoom tiers at their exact thresholds', () => {
    expect(resolveBenchZoomTier(0.49)).toBe('far');
    expect(resolveBenchZoomTier(0.5)).toBe('mid');
    expect(resolveBenchZoomTier(1)).toBe('mid');
    expect(resolveBenchZoomTier(1.01)).toBe('near');
  });

  it('builds the explicit conversation focus contract', () => {
    expect(buildFocusConversationCommand('thread-1')).toEqual({
      type: 'focus-node',
      key: 'bench:focus:thread-1',
      nodeId: 'thread-1',
      padding: { top: '8%', right: '12%', bottom: '8%', left: '12%' },
      zoom: 1.08,
      duration: 260,
    });
  });

  it('builds a fresh anchored reveal contract for the requested node', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(101).mockReturnValueOnce(102);
    const first = buildRevealNodeCommand('thread-1');
    const second = buildRevealNodeCommand('thread-1');

    expect(first).toEqual({
      type: 'focus-node-at-anchor',
      key: 'bench:reveal:thread-1:101',
      nodeId: 'thread-1',
      anchor: { horizontalRatio: 0.5, verticalRatio: 0.5 },
      zoom: 0.88,
      duration: 360,
    });
    expect(second.key).not.toBe(first.key);
    vi.restoreAllMocks();
  });

  it('restores only the remembered Bench viewport', () => {
    expect(buildRestoreViewportCommand()).toEqual({
      type: 'restore-viewport',
      key: 'bench:restore',
      viewportKey: 'messages:the-bench',
      duration: 260,
    });
  });

  it('clamps keyboard zoom commands to the Bench limits', () => {
    const input = { metaKey: false, ctrlKey: false, activeThreadId: null };
    expect(interpretBenchKey({ ...input, key: ']', currentZoom: 1.49 }).cameraCommand).toMatchObject({
      type: 'set-zoom',
      zoom: 1.5,
    });
    expect(interpretBenchKey({ ...input, key: '[', currentZoom: 0.26 }).cameraCommand).toMatchObject({
      type: 'set-zoom',
      zoom: 0.25,
    });
  });
});
