#!/usr/bin/env -S npx tsx
// nvk-server — boot the production composition root.
//
//   nvk-server --port <n> [--root .novakai] [--static <dir>] [--cwd <dir>]
//              [--watchdog-dir <dir>]
//
// The port is always stated (--port or NOVAKAI_PORT): 5180 belongs to the live
// instance and is REFUSED unless this code is a stamped release — only
// `nvk deploy` (scripts/deploy/) puts a server on 5180. Dev and scratch boots
// use `--port 0` (the OS picks; the ready line prints it) or any other port.
//
// One port serves the shell bundle, /bootstrap.json, /version and the WS upgrade.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { bootServer } from '../core/boot.js';
import { openConfigStore } from '../core/config/store.js';
import { LIVE_SERVER_PORT, resolveDataRoot, resolveServerLaunch } from '../core/launch-options.js';
import { readReleaseStamp } from '../core/release-stamp.js';
import {
  ConfigObjectInput as ConfigObjectInputSchema, configKeyOf, type ConfigObjectInput,
} from '../contract/config.js';
import { inspectLegacyDemoPersons } from '../core/doctor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const invocation = { argv: process.argv, env: process.env, repoRoot };

// The offline subcommands run before there is a server, so they need the root
// and nothing else — a port they will never bind must not gate them.
const root = resolveDataRoot(invocation);

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
  } else if (key === 'transcript' || key === 'cfg_transcript') {
    input = { ...value, configKind: 'transcript' };
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

const launch = resolveServerLaunch(invocation);
if (!launch.ok) {
  console.error(`\n[nvk-server] ${launch.error.code}\n  ${launch.error.message}\n`);
  process.exit(2);
}

// The live port is deploy-only: a mutable-checkout server on 5180 is exactly
// the runtime/data skew the deploy pipeline exists to kill, so it is refused
// here — at the last unsupervised door — not just discouraged in docs.
if (launch.value.port === LIVE_SERVER_PORT && readReleaseStamp().state !== 'stamped') {
  console.error(`\n[nvk-server] LivePortRequiresRelease\n  :${LIVE_SERVER_PORT} is the live instance's port and`
    + ' only runs stamped releases — use `nvk deploy`, or --port 0 for a dev/scratch boot\n');
  process.exit(2);
}

const booted = await bootServer(launch.value);

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
