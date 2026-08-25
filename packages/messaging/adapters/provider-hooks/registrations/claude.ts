import path from 'node:path';
import { ensureJsonIdentityHook } from './json-hook-registration.js';

interface ClaudeHookRegistrationOptions {
  readonly providerHome: string;
  readonly command: string;
}

/** Idempotently installs Novakai's UserPromptSubmit identity hook for Claude. */
export async function ensureClaudeIdentityHook(
  options: ClaudeHookRegistrationOptions,
): Promise<'installed' | 'unchanged'> {
  return ensureJsonIdentityHook({
    filePath: path.join(options.providerHome, '.claude', 'settings.json'),
    provider: 'Claude',
    command: options.command,
  });
}
