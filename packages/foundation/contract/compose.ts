// Composition: bind an engine + principal into a scoped store handle (R3-6).
// Consumers call composeHandle once (composition root), then use the free
// contract functions. Handles carrying another capability's kinds get
// ScopeViolation from the ENGINE runtime check on every write.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityId, ObjectKind } from './brands.js';
import type { ScopedStoreHandle } from './types.js';
import { StoreEngine } from '../core/store-engine/engine.js';

export interface ComposeOptions {
  root: string;                    // .novakai/
  legacyRoot?: string;             // .novakai-command/ dual-read fallback (R3-21)
  capability: CapabilityId;
  allowedKinds: readonly ObjectKind[];
  principal: string;               // token-derived (red gate 4) — the ONLY createdBy source
  lockTimeoutMs?: number;
  /** @internal test seam: injected trace failure. */
  failNextTraceAppend?: { cause: string };
  /** @internal test seam: injected object-append failure. */
  failNextObjectAppend?: { cause: string };
}

const engineCache = new Map<string, StoreEngine>();

export function composeEngine(options: ComposeOptions): StoreEngine {
  const key = `${path.resolve(options.root)}::${options.lockTimeoutMs ?? 5000}`;
  let engine = engineCache.get(key);
  if (!engine) {
    engine = new StoreEngine({
      root: options.root,
      legacyRoot: options.legacyRoot ?? defaultLegacyRoot(options.root),
      lockTimeoutMs: options.lockTimeoutMs,
    });
    engineCache.set(key, engine);
  }
  // Failure-injection seam applies per composition, not per cache key, so a
  // within-session retry reconciles against the SAME booted engine (R3-10).
  if (options.failNextTraceAppend) engine.failNextTraceAppend = options.failNextTraceAppend;
  if (options.failNextObjectAppend) engine.failNextObjectAppend = options.failNextObjectAppend;
  return engine;
}

function defaultLegacyRoot(root: string): string | undefined {
  const legacy = path.join(path.dirname(path.resolve(root)), '.novakai-command');
  return existsSync(legacy) ? legacy : undefined;
}

export function composeHandle(options: ComposeOptions): ScopedStoreHandle {
  return {
    capability: options.capability,
    allowedKinds: new Set(options.allowedKinds),
    __engine: composeEngine(options),
    __principal: options.principal,
  };
}
