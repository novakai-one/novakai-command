#!/usr/bin/env -S npx tsx
// nvk-server — boot the production composition root.
//
//   nvk-server [--port 5180] [--root .novakai] [--static <dir>] [--cwd <dir>]
//
// Cold start (§13 disposition 4):
//   1) npx tsx packages/server/cli/nvk-token.ts mint person_chris \
//        --grants layout,settings,conversationView --roles Human
//   2) npx tsx packages/server/cli/nvk-server.ts
//
// One port serves the shell bundle, /bootstrap.json and the WS upgrade.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { bootServer } from '../core/boot.js';
import { openConfigStore } from '../core/config/store.js';
import {
  ConfigObjectInput as ConfigObjectInputSchema, configKeyOf, type ConfigObjectInput,
} from '../contract/config.js';
import { inspectLegacyDemoPersons } from '../core/doctor.js';

const flag = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const root = flag('root') ?? process.env.NOVAKAI_ROOT ?? path.join(repoRoot, '.novakai');
const port = Number(flag('port') ?? process.env.NOVAKAI_PORT ?? 5180);
const cwd = flag('cwd') ?? repoRoot;
const staticDir = flag('static') ?? path.join(repoRoot, 'packages', 'shell', 'dist');

if (process.argv[2] === 'doctor') {
  console.log(JSON.stringify(inspectLegacyDemoPersons(root)));
  process.exit(0);
}

function configInputFor(key: string, jsonValue: unknown): ConfigObjectInput {
  if (!jsonValue || typeof jsonValue !== 'object' || Array.isArray(jsonValue)) {
    throw new Error('config-set jsonValue must be a JSON object');
  }
  const value = jsonValue as Record<string, unknown>;
  let input: Record<string, unknown>;
  if (key === 'dev' || key === 'cfg_dev') {
    input = { ...value, configKind: 'dev' };
  } else if (key === 'supervision' || key === 'cfg_supervision') {
    input = { ...value, configKind: 'supervision' };
  } else if (key.startsWith('provider.') || key.startsWith('cfg_provider_')) {
    const provider = key.startsWith('provider.')
      ? key.slice('provider.'.length)
      : key.slice('cfg_provider_'.length);
    input = { ...value, configKind: 'provider', provider };
  } else if (key.startsWith('principal.') || key.startsWith('cfg_principal_')) {
    const personId = key.startsWith('principal.')
      ? key.slice('principal.'.length)
      : key.slice('cfg_principal_'.length);
    input = { ...value, configKind: 'principal', personId };
  } else if (key.startsWith('binding.') || key.startsWith('cfg_binding_')) {
    const agentId = key.startsWith('binding.')
      ? key.slice('binding.'.length)
      : key.slice('cfg_binding_'.length);
    input = { ...value, configKind: 'agentPersonBinding', agentId };
  } else {
    throw new Error(`unknown config key "${key}"`);
  }
  return ConfigObjectInputSchema.parse(input);
}

if (process.argv[2] === 'config-set') {
  const key = process.argv[3];
  const rawValue = process.argv[4];
  if (!key || rawValue === undefined) {
    throw new Error('usage: nvk-server config-set <key> <jsonValue> [--root <dir>]');
  }
  let jsonValue: unknown;
  try { jsonValue = JSON.parse(rawValue); } catch {
    throw new Error(`config-set jsonValue is not valid JSON: ${rawValue}`);
  }
  const input = configInputFor(key, jsonValue);
  const opened = await openConfigStore({ root, principal: 'sys_spine' });
  if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
  const set = await opened.value.set(input, mintClientOpId());
  if (!set.ok) throw new Error(`${set.error.code}: ${set.error.message}`);
  console.log(JSON.stringify({ ok: true, key: configKeyOf(ConfigObjectInputSchema.parse(input)) }));
  process.exit(0);
}

const booted = await bootServer({
  root, port, cwd, staticDir, watchdogDir: repoRoot,
  ...(flag('kimi-cli') ? { kimiCliPath: flag('kimi-cli')! } : {}),
});

if (!booted.ok) {
  console.error(`\n[nvk-server] BOOT ABORTED (${booted.error.code})\n  ${booted.error.message}\n`);
  process.exit(1);
}

const server = booted.value;
if (server.interrupted.length > 0) {
  console.warn(`[nvk-server] ${server.interrupted.length} reply/replies were interrupted by the last shutdown — surfaced for manual resend, never auto-retried`);
}
console.log(`[nvk-server] ready — open ${server.url}`);

const shutdown = (signal: string): void => {
  console.log(`[nvk-server] ${signal} — shutting down`);
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
