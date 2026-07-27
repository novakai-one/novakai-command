// shell/ui/inspector/registry.ts — per-kind inspector screens (DEC-S2-8).
// Kinds WITHOUT a registered screen render the generic inspector (ruling 10).
// UI-side component registry: the mount contract (registerScreen) carries the
// kindRef→screenId declaration; this maps kind → the React screen itself.
import type { ComponentType } from 'react';

export interface InspectorScreenProps {
  envelope?: Record<string, unknown>;
  payload?: unknown;
  onAction?: (actionId: string) => void;
}

const screens = new Map<string, ComponentType<InspectorScreenProps>>();

export function registerInspectorScreen(kind: string, screen: ComponentType<InspectorScreenProps>): void {
  screens.set(kind, screen);
}

export function inspectorScreenFor(kind: string): ComponentType<InspectorScreenProps> | null {
  return screens.get(kind) ?? null;
}

/** Test/boot seam. */
export function __resetInspectorRegistry(): void {
  screens.clear();
}
