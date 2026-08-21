import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

const LIBRARY_PANEL_STORAGE_KEY = 'novakai:messages:the-bench:library:v1';
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 336;

type StoredPanelState = {
  readonly expanded: boolean;
  readonly width: number;
};

let panelStorageAvailable = true;

const clampWidth = (width: number): number => (
  Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)))
);

function readStoredPanelState(): StoredPanelState {
  const fallback = { expanded: false, width: DEFAULT_PANEL_WIDTH };
  if (typeof window === 'undefined' || !panelStorageAvailable) return fallback;
  try {
    const raw = window.localStorage.getItem(LIBRARY_PANEL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredPanelState>;
    return {
      expanded: parsed.expanded === true,
      width: typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? clampWidth(parsed.width)
        : DEFAULT_PANEL_WIDTH,
    };
  } catch {
    return fallback;
  }
}

/** Pointer-drag width resizing; the settled width persists as expanded=true. */
function useResizeDrag(
  widthRef: MutableRefObject<number>,
  setWidth: (width: number) => void,
  persist: (next: StoredPanelState) => void,
): (event: { clientX: number; preventDefault(): void }) => void {
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const startResize = useCallback((event: { clientX: number; preventDefault(): void }) => {
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: widthRef.current };
  }, [widthRef]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
    };
    const onUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      persist({ expanded: true, width: widthRef.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [persist, setWidth, widthRef]);

  return startResize;
}

/** Panel presentation state — expanded/width persist; query and stacks reset. */
export function useLibraryPanel(): {
  readonly expanded: boolean;
  readonly width: number;
  readonly query: string;
  readonly openStackKeys: ReadonlySet<string>;
  readonly archiveOpen: boolean;
  readonly setExpanded: (expanded: boolean) => void;
  readonly setQuery: (query: string) => void;
  readonly toggleStack: (key: string) => void;
  readonly setArchiveOpen: (open: boolean) => void;
  readonly startResize: (event: { clientX: number; preventDefault(): void }) => void;
} {
  const [stored] = useState(readStoredPanelState);
  const [expanded, setExpandedState] = useState(stored.expanded);
  const [width, setWidth] = useState(stored.width);
  const [query, setQuery] = useState('');
  const [openStackKeys, setOpenStackKeys] = useState<ReadonlySet<string>>(new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = useCallback((next: StoredPanelState) => {
    try {
      window.localStorage.setItem(LIBRARY_PANEL_STORAGE_KEY, JSON.stringify(next));
    } catch {
      panelStorageAvailable = false; // volatile session — the panel just forgets its shape
    }
  }, []);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    persist({ expanded: next, width: widthRef.current });
  }, [persist]);

  const toggleStack = useCallback((key: string) => {
    setOpenStackKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const startResize = useResizeDrag(widthRef, setWidth, persist);

  return {
    expanded, width, query, openStackKeys, archiveOpen,
    setExpanded, setQuery, toggleStack, setArchiveOpen, startResize,
  };
}
