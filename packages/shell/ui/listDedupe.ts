// shell/ui/listDedupe.ts — G5 glitch fix: defensive render-time dedupe.
// Even with idempotent seeding (G4), a stale/duplicated list payload must
// never paint the same row twice. Generic by-id dedupe, first occurrence wins.

export function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
