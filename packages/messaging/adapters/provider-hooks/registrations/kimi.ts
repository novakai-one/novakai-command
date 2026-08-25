import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNovakaiIdentityCommand } from './owned-hook.js';

const assignment = (line: string, name: string): string | undefined => {
  const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`));
  if (match?.[1] === undefined) return undefined;
  const literal = match[1];
  if (literal.startsWith("'") && literal.endsWith("'")) return literal.slice(1, -1);
  try {
    const value = JSON.parse(literal) as unknown;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

const hookValue = (block: string, name: string): string | undefined =>
  block.split(/\r?\n/u)
    .map((line) => assignment(line, name))
    .find((value) => value !== undefined);

const withoutNovakaiHooks = (config: string): string =>
  config.split(/(?=^\s*\[\[hooks\]\]\s*(?:#.*)?$)/mu)
    .filter((block) =>
      hookValue(block, 'event') !== 'UserPromptSubmit'
      || !isNovakaiIdentityCommand(hookValue(block, 'command')))
    .join('')
    .trimEnd();

async function readConfig(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause
      && cause.code === 'ENOENT') return '';
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Kimi config cannot be read: ${message}`);
  }
}

/** Idempotently appends Novakai's Kimi UserPromptSubmit identity hook. */
export async function ensureKimiIdentityHook(options: {
  readonly providerHome: string;
  readonly command: string;
}): Promise<'installed' | 'unchanged'> {
  const filePath = path.join(options.providerHome, '.kimi-code', 'config.toml');
  const config = await readConfig(filePath);
  const block = [
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    `command = ${JSON.stringify(options.command)}`,
    'timeout = 5',
    '',
  ].join('\n');
  const retained = withoutNovakaiHooks(config);
  const next = `${retained}${retained.length === 0 ? '' : '\n\n'}${block}`;
  if (next === config) return 'unchanged';
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.novakai-${process.pid}.tmp`;
  await writeFile(temporary, next, 'utf8');
  await rename(temporary, filePath);
  return 'installed';
}
