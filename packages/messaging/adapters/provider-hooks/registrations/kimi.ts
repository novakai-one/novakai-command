import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrno, thrownMessage } from '../../../core/thrown.js';
import { isNovakaiIdentityCommand } from './owned-hook.js';

const singleQuoted = (literal: string): boolean =>
  literal.startsWith("'") && literal.endsWith("'");

function parseJsonString(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    if (typeof value !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** One TOML string literal: single-quoted verbatim, or JSON-quoted with escapes. */
function parseTomlString(literal: string): string | undefined {
  if (singleQuoted(literal)) return literal.slice(1, -1);
  return parseJsonString(literal);
}

function assignment(line: string, name: string): string | undefined {
  const literal = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`))?.[1];
  if (literal === undefined) return undefined;
  return parseTomlString(literal);
}

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
    if (isErrno(cause, 'ENOENT')) return '';
    throw new Error(`Kimi config cannot be read: ${thrownMessage(cause)}`);
  }
}

/**
 * Idempotently appends Novakai's Kimi UserPromptSubmit identity hook.
 * Atomic write (temp file plus rename, pid-named so two install processes
 * never share one file) so a crash mid-write never leaves a truncated
 * config; an orphaned temp is overwritten by the next install. Fs
 * explosions propagate to the compose door (contract/compose/ingestion.ts),
 * which wraps them as typed DependencyUnavailable.
 */
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
