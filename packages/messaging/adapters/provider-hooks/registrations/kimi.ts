import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

const containsHook = (config: string, command: string): boolean =>
  config.split(/(?=^\s*\[\[hooks\]\]\s*(?:#.*)?$)/mu)
    .filter((block) => /^\s*\[\[hooks\]\]/u.test(block))
    .some((block) =>
      hookValue(block, 'event') === 'UserPromptSubmit'
      && hookValue(block, 'command') === command);

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
  if (containsHook(config, options.command)) return 'unchanged';
  const separator = config.length === 0 ? '' : config.endsWith('\n') ? '\n' : '\n\n';
  const block = [
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    `command = ${JSON.stringify(options.command)}`,
    'timeout = 5',
    '',
  ].join('\n');
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.novakai-${process.pid}.tmp`;
  await writeFile(temporary, `${config}${separator}${block}`, 'utf8');
  await rename(temporary, filePath);
  return 'installed';
}
