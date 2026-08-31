// The three production provider adapters, as one registry.
//
// A composition root asks for this and gets whatever is actually installed on
// the machine. A provider whose CLI is absent is still present in the registry
// and answers `unavailable` to everything — because "we could not find the CLI"
// is a fact Chris should be able to read, and a missing map entry is a crash.
import type { ProviderAdapterRegistry } from '../../contract/providers.js';
import { createClaudeAdapter, type ClaudeAdapterOptions } from './claude.js';
import { createCodexAdapter, type CodexAdapterOptions } from './codex.js';
import { createKimiAdapter, type KimiAdapterOptions } from './kimi.js';

export interface ProviderAdapterOptions {
  readonly claude?: ClaudeAdapterOptions;
  readonly codex?: CodexAdapterOptions;
  readonly kimi?: KimiAdapterOptions;
}

export function createProviderAdapters(
  options: ProviderAdapterOptions = {},
): ProviderAdapterRegistry {
  return {
    claude: createClaudeAdapter(options.claude ?? {}),
    codex: createCodexAdapter(options.codex ?? {}),
    kimi: createKimiAdapter(options.kimi ?? {}),
  };
}
