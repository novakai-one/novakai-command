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
import { bootServer } from '../core/boot.js';

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
