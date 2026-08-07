// B1b §10 EXIT EVIDENCE — live fire against the REAL codex and claude CLIs.
//
// Not a test: an operator script. It boots the real composition root, spawns a
// real codex session in a git-repo cwd and a real claude session, sends each
// one a message through the real path (messaging → live lane → adapter), and
// prints what came back plus the usage table the supervision engine measured.
//
//   npx tsx packages/server/tests/live-fire.mts [--port 5190] [--keep]
//
// --keep leaves the server listening so the shell can be driven in a browser.
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
const keep = process.argv.includes('--keep');
const port = Number(arg('port', '5190'));
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const novakaiRoot = arg('root', path.join(mkdtempSync(path.join(tmpdir(), 'nvk-b1b-live-')), '.novakai'));
mkdirSync(novakaiRoot, { recursive: true });

const log = (...parts: unknown[]): void => console.log('[live-fire]', ...parts);

const opened = await openConfigStore({ root: novakaiRoot, principal: 'sys_spine' });
if (!opened.ok) throw new Error(`config store: ${opened.error.message}`);
const token = opened.value.mintPrincipalToken({
  personId: 'person_chris', roles: ['Human'], grants: ['layout', 'settings', 'conversationView'],
});
await opened.value.set(
  { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: token.id },
  mintClientOpId(),
);
// codex REQUIRES a git-repo cwd; the worktree is one, so both providers run there.
for (const provider of ['codex', 'claude'] as const) {
  await opened.value.set({ configKind: 'provider', provider, cwd: repoRoot }, mintClientOpId());
}

const booted = await bootServer({
  root: novakaiRoot, port, cwd: repoRoot, watchdogDir: novakaiRoot,
  staticDir: path.join(repoRoot, 'packages/shell/dist'),
  supervisionTimers: true,
});
if (!booted.ok) throw new Error(`boot: ${booted.error.code} ${booted.error.message}`);
const server = booted.value;
log('server up at', server.url);
for (const step of server.steps) log(`  step ${step.step} ${step.name}: ${step.detail}`);

const methods = buildMethods(server.runtime);

async function exercise(provider: 'codex' | 'claude', prompt: string): Promise<void> {
  log(`── ${provider} ─────────────────────────────────────────`);
  const spawned = await methods.spawnAgentConversation!(
    { title: `Live ${provider}`, provider } as never) as
    { ok: boolean; sessionId?: string; conversation?: { id: string }; error?: string };
  if (!spawned.ok) { log(`${provider} SPAWN FAILED:`, spawned.error); return; }
  const sessionId = spawned.sessionId!;
  log(`spawned sessionId=${sessionId} conversation=${spawned.conversation!.id}`);

  const replies: string[] = [];
  server.runtime.providerRuntimes[provider]!.onData((key, data) => {
    if (key === sessionId) replies.push(data);
  });

  const sent = await methods.sendMessage!(
    { conversationId: spawned.conversation!.id, text: prompt } as never) as { ok: boolean; error?: unknown };
  if (!sent.ok) { log(`${provider} SEND FAILED:`, JSON.stringify(sent.error)); return; }
  await server.runtime.providerRuntimes[provider]!.drain(sessionId);

  const record = (await server.sessions.get(sessionId))!;
  log(`REPLY: ${replies.join('').trim().slice(0, 300)}`);
  log(`providerConversationId (resume handle): ${record.providerConversationId}`);
  log(`turns=${record.turns} inFlight=${record.inFlight.status}`);

  // Turn 2 proves the RESUME mechanism: same logical session, new process.
  const sent2 = await methods.sendMessage!(
    { conversationId: spawned.conversation!.id, text: 'Reply with exactly: resumed-ok' } as never) as { ok: boolean };
  if (sent2.ok) {
    await server.runtime.providerRuntimes[provider]!.drain(sessionId);
    const after = (await server.sessions.get(sessionId))!;
    log(`TURN 2 REPLY: ${replies.join('').trim().slice(-200)}`);
    log(`same conversation id after turn 2: ${after.providerConversationId === record.providerConversationId}`);
    log(`turns=${after.turns}`);
  }
}

await exercise('codex', 'Reply with exactly: b1b-codex-live');
await exercise('claude', 'Reply with exactly: b1b-claude-live');

log('── usage table (REAL counts from provider transcripts) ──');
const table = await server.supervision.usageTable();
for (const row of table.rows) {
  log(`  ${row.provider.padEnd(7)} ${row.agentId} turns=${row.turns} `
    + `in=${row.inputTokens ?? '—'} out=${row.outputTokens ?? '—'} `
    + `cacheRead=${row.cacheReadTokens ?? '—'} adjusted=${row.cumulativeAdjusted}`);
  log(`          ${row.note}`);
}
await server.supervision.emitUsage();
log(`usage.jsonl written under ${novakaiRoot}/supervision/`);

log('── cheap-first drift check ──');
const drift = await server.supervision.checkDrift();
log(`providerTurnsSpent=${drift.providerTurnsSpent} (SR-1: zero for live sessions)`);
for (const row of drift.rows) log(`  ${row.sessionId} live=${row.live} action=${row.action}`);

if (keep) {
  log(`KEEPING SERVER UP at ${server.url} — root ${novakaiRoot}`);
} else {
  await server.close();
  log('done');
  process.exit(0);
}
