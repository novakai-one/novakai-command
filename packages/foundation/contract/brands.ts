// §1 Branded Identifier Types (Pass 2 S1 contracts).
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ObjectId = Brand<string, 'objectId'>;
export type AgentId = Brand<string, 'agentId'>;
export type PersonId = Brand<string, 'personId'>;
export type SessionId = Brand<string, 'sessionId'>;
export type ProjectId = Brand<string, 'projectId'>;
export type ArtifactId = Brand<string, 'artifactId'>;
export type ConversationId = Brand<string, 'conversationId'>;

export type ClientOpId = Brand<string, 'clientOpId'>; // "op_<uuidv4>" — REQUIRED on all mutating ops (R3-10)
export type ServerOpId = Brand<string, 'serverOpId'>; // "srv_<uuidv4>"

export type SystemPrincipal = 'sys_ingester' | 'sys_reconciler' | 'sys_spine';
export type Principal = AgentId | PersonId | SystemPrincipal;

export type ObjectKind =
  | 'agent'
  | 'skill'
  | 'layout'
  | 'settings'
  | 'conversationView' // S2 F1/DEC-S2-11: shell-owned pin/archive view state
  | 'config'          // B1 DEC-B1-3: server-owned typed config objects
  | 'quarantine'
  | 'token'
  | 'trace';

export type CapabilityId =
  | 'foundation' | 'shell' | 'agents' | 'messaging'
  | 'terminal' | 'transcript' | 'spine'
  | 'server'; // B1: the production composition root (owns kind 'config')

// ── Mint helpers (identity conventions: foundation owns conventions, §8) ──
import { randomUUID } from 'node:crypto';

export const mintClientOpId = (): ClientOpId => `op_${randomUUID()}` as ClientOpId;
export const mintServerOpId = (): ServerOpId => `srv_${randomUUID()}` as ServerOpId;
export const mintObjectId = (kind: string): ObjectId => `${kind}_${randomUUID()}` as ObjectId;
