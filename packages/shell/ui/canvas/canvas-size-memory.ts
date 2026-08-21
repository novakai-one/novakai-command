// canvas-size-memory.ts — user-chosen node sizes, remembered beside (but
// independent of) canvas-memory's positions. Sizes are written by resize
// handles at drag-end and read back at projection time, so a re-projection
// never snaps a node back to its default dimensions.
const SIZE_MEMORY_STORAGE_KEY = 'novakai:world-canvas:sizes:v1';

/** One remembered node size in world units. */
export type RememberedNodeSize = {
  readonly width: number;
  readonly height: number;
};

const rememberedSizes = new Map<string, Map<string, RememberedNodeSize>>();
let hasLoadedBrowserSizes = false;
let browserSizesAvailable = true;

const isUsable = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

function loadBrowserSizes(): void {
  if (hasLoadedBrowserSizes || typeof window === 'undefined') return;
  hasLoadedBrowserSizes = true;
  try {
    const raw = window.localStorage.getItem(SIZE_MEMORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Record<string, Partial<RememberedNodeSize>>>;
    for (const [memoryKey, sizes] of Object.entries(parsed)) {
      const valid = Object.entries(sizes)
        .filter((entry): entry is [string, RememberedNodeSize] => (
          isUsable(entry[1]?.width) && isUsable(entry[1]?.height)
        ))
        .map(([nodeId, size]) => [nodeId, { width: size.width, height: size.height }] as const);
      rememberedSizes.set(memoryKey, new Map(valid));
    }
  } catch {
    browserSizesAvailable = false;
    try {
      window.localStorage.removeItem(SIZE_MEMORY_STORAGE_KEY);
    } catch {
      // The in-memory maps remain the same-runtime fallback.
    }
  }
}

function storeBrowserSizes(): void {
  if (typeof window === 'undefined' || !browserSizesAvailable) return;
  try {
    window.localStorage.setItem(SIZE_MEMORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(
      [...rememberedSizes].map(([memoryKey, sizes]) => [memoryKey, Object.fromEntries(sizes)]),
    )));
  } catch {
    browserSizesAvailable = false;
  }
}

/** Reads the size a person chose for one node, if they ever resized it. */
export function readRememberedNodeSize(
  memoryKey: string,
  nodeId: string,
): RememberedNodeSize | undefined {
  loadBrowserSizes();
  const size = rememberedSizes.get(memoryKey)?.get(nodeId);
  return size ? { ...size } : undefined;
}

/** Remembers a settled resize. Non-positive dimensions are refused, not stored. */
export function rememberNodeSize(
  memoryKey: string,
  nodeId: string,
  size: RememberedNodeSize,
): void {
  if (!isUsable(size.width) || !isUsable(size.height)) return;
  loadBrowserSizes();
  const sizes = rememberedSizes.get(memoryKey) ?? new Map<string, RememberedNodeSize>();
  sizes.set(nodeId, { width: size.width, height: size.height });
  rememberedSizes.set(memoryKey, sizes);
  storeBrowserSizes();
}
