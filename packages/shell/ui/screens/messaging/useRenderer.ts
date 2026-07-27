// shell/ui/screens/messaging/useRenderer.ts — binds ThreadRenderer to React.
// Renders incoming text at the user's speed; gap marker on flush-oldest.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ThreadRenderer } from '../../../contract/renderer.js';

export interface RenderedSegment { text: string; gapBefore: boolean }

export function useRenderer(opts: { speed: number; capTokens?: number; live: boolean }) {
  const renderer = useMemo(() => new ThreadRenderer({ speed: opts.speed, capTokens: opts.capTokens }), []);
  const [segments, setSegments] = useState<RenderedSegment[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // SHL-007: speed change applies to the unrendered backlog immediately.
  useEffect(() => { renderer.setSpeed(opts.speed); }, [opts.speed, renderer]);

  useEffect(() => {
    // Motion discipline (M-19): the render pump only ticks for the focused
    // conversation; background chats update via static message appends.
    if (!opts.live) return;
    timer.current = setInterval(() => {
      const chunk = renderer.tick(100);
      if (chunk.text || chunk.gapBefore) {
        setSegments((s) => [...s, { text: chunk.text, gapBefore: chunk.gapBefore }]);
      }
    }, 100);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [renderer, opts.live]);

  return {
    feed: (text: string) => renderer.feed(text),
    segments,
    snapshot: () => renderer.snapshot(),
    reset: () => { renderer.discard(); setSegments([]); },
  };
}
