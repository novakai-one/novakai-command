import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface ClaudeHookRegistrationOptions {
  readonly providerHome: string;
  readonly command: string;
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

async function readSettings(filePath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    const settings = object(parsed);
    if (settings === undefined) throw new Error('settings root must be an object');
    return settings;
  } catch (cause) {
    if (object(cause)?.code === 'ENOENT') return {};
    throw new Error(`Claude settings cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const containsCommand = (entries: readonly unknown[], command: string): boolean =>
  entries.some((entry) => {
    const hooks = object(entry)?.hooks;
    return Array.isArray(hooks) && hooks.some((hook) => object(hook)?.command === command);
  });

/** Idempotently installs Novakai's UserPromptSubmit identity hook for Claude. */
export async function ensureClaudeIdentityHook(
  options: ClaudeHookRegistrationOptions,
): Promise<'installed' | 'unchanged'> {
  const filePath = path.join(options.providerHome, '.claude', 'settings.json');
  const settings = await readSettings(filePath);
  const hooks = object(settings.hooks) ?? {};
  const promptHooks = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit : [];
  if (containsCommand(promptHooks, options.command)) return 'unchanged';
  const next = {
    ...settings,
    hooks: {
      ...hooks,
      UserPromptSubmit: [
        ...promptHooks,
        { hooks: [{ type: 'command', command: options.command }] },
      ],
    },
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.novakai-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
  return 'installed';
}
