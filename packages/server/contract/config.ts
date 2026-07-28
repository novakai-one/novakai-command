// packages/server/contract/config.ts — the CONFIG contract (DEC-B1-3).
//
// Principals, agent↔person bindings, provider settings, supervision policy and
// dev switches are CONFIG, not code (HANDOVER law; B1 red gate 1). They live as
// typed foundation objects of kind 'config' in `.novakai/config.jsonl`; the
// server is their sole writer, latest line wins per config key (§13
// disposition 6).
//
// Bearer secrets NEVER live here: a principal object carries a tokenId
// REFERENCE into the foundation token store (`.novakai/tokens/<id>.json`).
import { z } from 'zod';

export type ProviderName = 'kimi' | 'claude' | 'codex' | 'mock';
export const PROVIDER_NAMES: readonly ProviderName[] = ['kimi', 'claude', 'codex', 'mock'];

// ── the five config object shapes (input side: what an operator/CLI writes) ──

export const PrincipalConfigInput = z.object({
  configKind: z.literal('principal'),
  personId: z.string().min(1),
  roles: z.array(z.string()).default([]),
  /** Reference into the foundation token store. The bearer is resolved at boot. */
  tokenId: z.string().min(1),
});

export const AgentPersonBindingInput = z.object({
  configKind: z.literal('agentPersonBinding'),
  agentId: z.string().min(1),
  personId: z.string().min(1),
});

export const ProviderConfigInput = z.object({
  configKind: z.literal('provider'),
  provider: z.enum(['kimi', 'claude', 'codex', 'mock']),
  /** Absolute path to the provider CLI. Absent = the adapter's own default. */
  cliPath: z.string().optional(),
  /** 'cli-default' = spawn WITHOUT a model flag (red gate 3: never invent one). */
  defaultModel: z.string().optional(),
  /** Working directory for spawned processes (codex needs a git-repo root). */
  cwd: z.string().optional(),
  /** Rolling history cap for providers with no native resume (§13 disposition 5). */
  historyWindowTurns: z.number().int().positive().optional(),
});

export const SupervisionConfigInput = z.object({
  configKind: z.literal('supervision'),
  usageIntervalSec: z.number().int().positive().optional(),
  driftIntervalSec: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().positive().optional(),
});

export const DevConfigInput = z.object({
  configKind: z.literal('dev'),
  /** Gates the mock provider adapter out of production (closes M10). */
  allowMock: z.boolean(),
  /**
   * Start the S2 transcript watchers at boot. OFF by default in B1a: the S2
   * watcher scans and copies SYNCHRONOUSLY, and at real provider-transcript
   * volume (measured 2.5 GB on 2026-07-28) that starves the HTTP loop — every
   * page and asset took 5–12 s to serve. Boot step 5 still runs and still
   * traces; it reports "disabled" until the watcher moves off the main loop
   * (B1b/S3, where transcript ingestion actually lands).
   */
  watchTranscripts: z.boolean().optional(),
});

export const ConfigObjectInput = z.discriminatedUnion('configKind', [
  PrincipalConfigInput, AgentPersonBindingInput, ProviderConfigInput,
  SupervisionConfigInput, DevConfigInput,
]);
export type ConfigObjectInput = z.input<typeof ConfigObjectInput>;
export type ConfigObject = z.output<typeof ConfigObjectInput>;
export type ConfigKind = ConfigObject['configKind'];

// ── the resolved snapshot (output side: what the composition root consumes) ──

export interface ResolvedPrincipal {
  /** The bearer secret, read from the token record — never from config.jsonl. */
  token: string;
  personId: string;
  roles: string[];
  tokenId: string;
}

export interface UnresolvedPrincipal {
  personId: string;
  tokenId: string;
  reason: string;
}

export interface ProviderSettings {
  provider: ProviderName;
  cliPath?: string;
  /** 'cli-default' means: pass no model flag at all. */
  defaultModel: string;
  cwd?: string;
  historyWindowTurns: number;
}

export interface SupervisionPolicy {
  usageIntervalSec: number;
  driftIntervalSec: number;
  idleTimeoutSec: number;
}

export interface ServerConfig {
  principals: ResolvedPrincipal[];
  /** Principals whose token record is gone: drawn absence, never a crash (DEC-F2). */
  unresolvedPrincipals: UnresolvedPrincipal[];
  bindings: Array<{ agentId: string; personId: string }>;
  providers: Record<ProviderName, ProviderSettings>;
  supervision: SupervisionPolicy;
  dev: { allowMock: boolean; watchTranscripts: boolean };
}

/** Defaults materialized on first boot. Principals are deliberately absent. */
export const DEFAULT_SUPERVISION: SupervisionPolicy = Object.freeze({
  usageIntervalSec: 300, // Chris's 5–10 min band, OD-B1-4 default
  driftIntervalSec: 300,
  idleTimeoutSec: 900,
});
export const DEFAULT_HISTORY_WINDOW_TURNS = 8;
/** Red gate 3: the shipped default is "let the CLI decide", not a model name. */
export const CLI_DEFAULT_MODEL = 'cli-default';

/** The deterministic store id for a config object — this is its "config key". */
export function configKeyOf(input: ConfigObject): string {
  switch (input.configKind) {
    case 'principal': return `cfg_principal_${input.personId}`;
    case 'agentPersonBinding': return `cfg_binding_${input.agentId}`;
    case 'provider': return `cfg_provider_${input.provider}`;
    case 'supervision': return 'cfg_supervision';
    case 'dev': return 'cfg_dev';
  }
}
