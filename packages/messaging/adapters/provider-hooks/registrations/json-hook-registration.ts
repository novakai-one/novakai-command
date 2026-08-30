import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrno, thrownMessage } from '../../../core/thrown.js';
import { isNovakaiIdentityCommand } from './owned-hook.js';

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

function parseConfigText(text: string): JsonObject {
  const config = asObject(JSON.parse(text));
  if (config === undefined) throw new Error('configuration root must be an object');
  return config;
}

async function readConfig(filePath: string, provider: string): Promise<JsonObject> {
  try {
    return parseConfigText(await readFile(filePath, 'utf8'));
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return {};
    throw new Error(`${provider} hooks cannot be read: ${thrownMessage(cause)}`);
  }
}

/** Drops Novakai-owned hooks from one entry; returns [] when the entry held nothing else. */
function stripNovakaiHooks(entry: unknown): readonly unknown[] {
  const candidate = asObject(entry);
  const hooks = candidate?.hooks;
  if (candidate === undefined || !Array.isArray(hooks)) return [entry];
  const retained = hooks.filter((hook) => !isNovakaiIdentityCommand(asObject(hook)?.command));
  if (retained.length === 0) return [];
  return [{ ...candidate, hooks: retained }];
}

const withoutNovakaiHooks = (entries: readonly unknown[]): readonly unknown[] =>
  entries.flatMap(stripNovakaiHooks);

/**
 * Installs one Claude-compatible JSON UserPromptSubmit command hook
 * atomically: temp file plus rename, so a crash mid-write never leaves a
 * truncated config. The temp name carries the pid so two install
 * processes never share one file. An orphaned temp after a crash is
 * harmless — the next install overwrites it; fs explosions propagate to
 * the compose door (contract/compose/ingestion.ts), which wraps them as
 * typed DependencyUnavailable.
 */
export async function ensureJsonIdentityHook(options: {
  readonly filePath: string;
  readonly provider: string;
  readonly command: string;
}): Promise<'installed' | 'unchanged'> {
  const config = await readConfig(options.filePath, options.provider);
  const hooks = asObject(config.hooks) ?? {};
  const promptHooks = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit : [];
  const nextPromptHooks = [
    ...withoutNovakaiHooks(promptHooks),
    { hooks: [{ type: 'command', command: options.command }] },
  ];
  if (JSON.stringify(nextPromptHooks) === JSON.stringify(promptHooks)) return 'unchanged';
  const next = {
    ...config,
    hooks: {
      ...hooks,
      UserPromptSubmit: nextPromptHooks,
    },
  };
  await mkdir(path.dirname(options.filePath), { recursive: true });
  const temporary = `${options.filePath}.novakai-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, options.filePath);
  return 'installed';
}
