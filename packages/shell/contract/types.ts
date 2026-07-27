// shell/contract/types.ts — shell-owned zod schemas for its two kinds
// (layout + settings; shell is sole writer, R3-29) plus shared UI types.
// Mirrors Pass 2 §2 exactly; shell validates at its own seam (R3-12) and never
// imports foundation from browser code.
import { z } from 'zod';

export const LayoutRecord = z.object({
  kind: z.literal('layout'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  rail: z.object({
    side: z.enum(['left', 'right']),
    width: z.number().positive(),
    collapsed: z.boolean(),
    order: z.array(z.string()),
  }),
  workspace: z.object({ minWidth: z.number().positive() }),
  inspector: z.object({ width: z.number().positive(), collapsed: z.boolean() }),
  composer: z.object({ height: z.number().positive() }),
  window: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
});
export type LayoutRecord = z.infer<typeof LayoutRecord>;

export const LAYOUT_MAIN_ID = 'layout_main'; // §11 ruling 6: one layout object per install

export const SettingsRecord = z.object({
  kind: z.literal('settings'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
  derivedFrom: z.string().optional(),
});
export type SettingsRecord = z.infer<typeof SettingsRecord>;

export const DEFAULT_LAYOUT: Omit<LayoutRecord, 'kind' | 'id' | 'schemaVersion' | 'createdAt' | 'permissionLevel' | 'createdBy'> = {
  rail: { side: 'left', width: 264, collapsed: false, order: ['messaging'] },
  workspace: { minWidth: 420 },
  inspector: { width: 320, collapsed: true },
  composer: { height: 132 },
};

// ── Presence (SHL-006; consumes agents' agentEvent stream, R3-17) ──────────
export type AgentEvent =
  | { type: 'spawned'; agentId: string; sessionId: string; at: string }
  | { type: 'online'; agentId: string; sessionId: string; at: string }
  | { type: 'activity'; agentId: string; sessionId: string; at: string; activity: string }
  | { type: 'offline'; agentId: string; sessionId: string; at: string; reason: 'exited' | 'provider_error' | 'closed' };

export type PresenceState = 'offline' | 'online' | 'active';

export interface PresenceSnapshot {
  agentId: string;
  state: PresenceState;
  activity?: string;
  at?: string;
}

/**
 * The seam to packages/agents (S1: NOT imported — a sibling builds it in
 * parallel). The orchestrator wires the real subscribeAgentEvents later;
 * tests/demos inject a mock. (§11 ruling 8: snapshot is derived from the
 * latest agentEvent per agentId, never stored as authoritative.)
 */
export interface PresenceSource {
  subscribeAgentEvents(handler: (e: AgentEvent) => void): () => void;
}

export type Unsubscribe = () => void;

export interface Ref { kind: string; id: string }
