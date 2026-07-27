// shell/contract/mount.ts — mount registry (DEC-S9, R3-19, SHL-001).
// Apps register via dynamic import ONLY; a failed import means nothing was
// registered, and the rail renders exactly what is registered — no ghosts.
import { z } from 'zod';
import type { Ref } from './types.js';

export interface NavContribution {
  appId: string;
  label: string;      // rail label (sentence case per DESIGN-LAWS §20)
  icon?: string;      // kit icon name
  order?: number;
}

export interface ScreenRegistration {
  kindRef: string;        // ObjectKind this screen renders
  screenId: string;
  /** R3-12/§11 ruling 10: payload schemas register HERE at the mount seam. */
  payloadSchema?: z.ZodType<unknown>;
}

interface Registry {
  apps: Map<string, NavContribution>;
  screens: Map<string, ScreenRegistration>; // key: kindRef
}

const registry: Registry = { apps: new Map(), screens: new Map() };

export function registerApp(appId: string, navContribution: NavContribution): void {
  registry.apps.set(appId, { ...navContribution, appId });
}

export function registerScreen(kindRef: string, screenId: string, payloadSchema?: z.ZodType<unknown>): void {
  registry.screens.set(kindRef, { kindRef, screenId, payloadSchema });
}

export function mountedApps(): NavContribution[] {
  return [...registry.apps.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function screenFor(kindRef: string): ScreenRegistration | null {
  return registry.screens.get(kindRef) ?? null;
}

/** Parse a contract payload from `unknown` at the seam — never untyped rendering. */
export function parseScreenPayload(kindRef: string, payload: unknown): unknown {
  const reg = registry.screens.get(kindRef);
  if (!reg?.payloadSchema) return payload;
  return reg.payloadSchema.parse(payload);
}

/** Test/boot seam: clear the registry (SHL-001 boots prove absence leaves nothing). */
export function __resetMountRegistry(): void {
  registry.apps.clear();
  registry.screens.clear();
}

export interface AppModule {
  appId: string;
  mount(reg: { registerApp: typeof registerApp; registerScreen: typeof registerScreen }): void;
}

/**
 * Boot: dynamic-import each candidate app module. Absent package = failed
 * import = skipped silently (DEC-S9). Returns the ids that mounted.
 */
export async function bootApps(candidates: { appId: string; importPath: string }[]): Promise<string[]> {
  const mounted: string[] = [];
  for (const c of candidates) {
    try {
      const mod = (await import(/* @vite-ignore */ c.importPath)) as AppModule;
      mod.mount({ registerApp, registerScreen });
      mounted.push(c.appId);
    } catch {
      // absence is not an error — nothing registered, no ghost (SHL-001)
    }
  }
  return mounted;
}
