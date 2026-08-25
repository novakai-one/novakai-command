import path from 'node:path';
import { ensureJsonIdentityHook } from './json-hook-registration.js';

/** Idempotently installs Novakai's UserPromptSubmit identity hook for Codex. */
export function ensureCodexIdentityHook(options: {
  readonly providerHome: string;
  readonly command: string;
}): Promise<'installed' | 'unchanged'> {
  return ensureJsonIdentityHook({
    filePath: path.join(options.providerHome, '.codex', 'hooks.json'),
    provider: 'Codex',
    command: options.command,
  });
}
