import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNovakaiIdentityCommand } from './owned-hook.js';

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

async function readConfig(filePath: string, provider: string): Promise<JsonObject> {
  try {
    const config = object(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
    if (config === undefined) throw new Error('configuration root must be an object');
    return config;
  } catch (cause) {
    if (object(cause)?.code === 'ENOENT') return {};
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${provider} hooks cannot be read: ${message}`);
  }
}

const withoutNovakaiHooks = (entries: readonly unknown[]): readonly unknown[] =>
  entries.flatMap((entry) => {
    const candidate = object(entry);
    const hooks = candidate?.hooks;
    if (candidate === undefined || !Array.isArray(hooks)) return [entry];
    const retained = hooks.filter((hook) =>
      !isNovakaiIdentityCommand(object(hook)?.command));
    return retained.length === 0 ? [] : [{ ...candidate, hooks: retained }];
  });

/** Installs one Claude-compatible JSON UserPromptSubmit command hook atomically. */
export async function ensureJsonIdentityHook(options: {
  readonly filePath: string;
  readonly provider: string;
  readonly command: string;
}): Promise<'installed' | 'unchanged'> {
  const config = await readConfig(options.filePath, options.provider);
  const hooks = object(config.hooks) ?? {};
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
