// B1b slice 7 — browser-verification rig for the supervision surface.
//
// Two things a unit test cannot prove, set up here so they can be CLICKED:
//   1. the screen updates from the `usage` WS BROADCAST (usageIntervalSec=10)
//   2. exactly ONE row carries a mark, because exactly one session is the
//      exception — produced honestly, by leaving a send in flight and letting
//      the boot sweep turn it into a ReplyInterrupted (§13 disposition 2)
//
//   npx tsx packages/server/tests/live-surface.mts --port 5192
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { bootServer } from '../core/boot.js';
import { openConfigStore } from '../contract/index.js';
import { buildMethods } from '../core/methods.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const port = Number(arg('port', '5192'));
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const novakaiRoot = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-b1b-surface-')), '.novakai');
mkdirSync(novakaiRoot, { recursive: true });
const log = (...p: unknown[]): void => console.log('[live-surface]', ...p);

const opened = await openConfigStore({ root: novakaiRoot, principal: 'sys_spine' });
if (!opened.ok) throw new Error(opened.error.message);
const token = opened.value.mintPrincipalToken({
  personId: 'person_chris', roles: ['Human'], grants: ['layout', 'settings', 'conversationView'],
});
await opened.value.set(
  { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: token.id },
  mintClientOpId());
for (const provider of ['codex', 'claude'] as const) {
  await opened.value.set({ configKind: 'provider', provider, cwd: repoRoot }, mintClientOpId());
}
// Fast enough to watch in a browser without waiting out Chris's 5-minute band.
await opened.value.set(
  { configKind: 'supervision', usageIntervalSec: 10, driftIntervalSec: 10 }, mintClientOpId());

const bootOnce = async (timers: boolean) => {
  const res = await bootServer({
    root: novakaiRoot, port, cwd: repoRoot, watchdogDir: novakaiRoot,
    staticDir: path.join(repoRoot, 'packages/shell/dist'),
    supervisionTimers: timers,
  });
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.value;
};

// ── pass 1: two real sessions, one left mid-send ──────────────────────────
const first = await bootOnce(false);
const methods = buildMethods(first.runtime);

const claude = await methods.spawnAgentConversation!(
  { title: 'Healthy claude', provider: 'claude' } as never) as
  { ok: boolean; sessionId?: string; conversation?: { id: string } };
await methods.sendMessage!(
  { conversationId: claude.conversation!.id, text: 'Reply with exactly: surface-ok' } as never);
await first.runtime.providerRuntimes.claude!.drain(claude.sessionId!);
log('healthy claude session', claude.sessionId);

const stuck = await methods.spawnAgentConversation!(
  { title: 'Interrupted codex', provider: 'codex' } as never) as
  { ok: boolean; sessionId?: string; conversation?: { id: string } };
// Mark a send in flight and NEVER complete it — exactly the state a server that
// dies mid-generation leaves behind.
await first.sessions.markSending(stuck.sessionId!, { clientOpId: 'cmsg_interrupted_demo' });
log('codex session left mid-send', stuck.sessionId);
await first.close();

// ── pass 2: reboot — the sweep turns that into a ReplyInterrupted ─────────
const server = await bootOnce(true);
const swept = server.interrupted;
log(`boot sweep surfaced ${swept.length} interrupted send(s):`, swept.map((s) => s.clientOpId).join(', '));
const table = await server.supervision.usageTable();
for (const row of table.rows) {
  log(`  ${row.provider.padEnd(7)} interrupted=${row.interrupted ?? '—'} drift=${row.drift} `
    + `in=${row.inputTokens ?? '—'} out=${row.outputTokens ?? '—'}`);
}
log(`SERVER UP at ${server.url} — usage broadcast every 10s`);
