/**
 * nvk-connect smoke test (D-N6-3): the connect-your-agent client driven as a
 * CHILD PROCESS against the in-app door (pattern: the package's
 * tests/standalone/spawned-server.ts) — connect, authenticate, get PUSHED a
 * message, send one back. Zero imports from the client under test (it is a
 * foreign machine; the wire is the contract).
 * Run with `npx tsx src/backend/messagingV2/connectSmoke/connect-smoke.test.ts`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../../messagingV2/authority/index.js';
import { startMessagingV2 } from '../../messagingV2/index.js';
import { createTokenStore } from '../../messagingV2/tokens/index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-connect-smoke-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Smoke Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'worker-alice', provider: 'claude', teamId, missionId: 'mission_alpha' });
const externId = model.createAgent({ name: 'worker-remote', provider: 'claude', teamId, missionId: 'mission_alpha' });
const tokens = createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-connect-smoke-tokens-')), 'tokens.jsonl'));
const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-connect-smoke-journal-')), 'journal.jsonl');
const handle = await startMessagingV2({
  objectModel: model, storePath: journalPath, tokenStore: tokens, door: { port: 0 }, 'log': () => {},
});
assert.ok(handle.door !== null);

tokens.ensure(externId);
const externToken = tokens.tokenForAgent(externId) as string;
const clientPath = path.resolve('scripts/nvk-connect.mjs');
const child = spawn(process.execPath, [clientPath, '--url', `ws://127.0.0.1:${handle.door.port}`, '--token', externToken], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const outlines: Array<Record<string, unknown>> = [];
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  for (const line of chunk.split('\n')) {
    if (line.trim() !== '') outlines.push(JSON.parse(line) as Record<string, unknown>);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => { stderr += chunk; });

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for: ${label}\n--- child stderr ---\n${stderr}\n--- outlines ---\n${JSON.stringify(outlines)}`);
}

// --- connect + authenticate (the done definition, as a child process) -----------

await waitFor(() => outlines.some((line) => line['type'] === 'ready'), 'child handshakes and reports ready');
const ready = outlines.find((line) => line['type'] === 'ready');
assert.equal(ready?.['personId'], personIdForAgentId(externId), 'the child authenticated as the external agent');
console.log('connect handshake tests passed');

// --- pushed inbound: alice (in-process) → external (child), never polled ---------

tokens.ensure(aliceId);
const aliceAuth = await handle.embedded.authenticate({ token: tokens.tokenForAgent(aliceId) });
if (aliceAuth.kind !== 'authenticated') throw new Error('unreachable');
const externAuth = await handle.embedded.authenticate({ token: externToken });
if (externAuth.kind !== 'authenticated') throw new Error('unreachable');
await aliceAuth.session.setContactPolicy({ allowlist: [personIdForAgentId(externId)], defaultRule: 'deny' });
await externAuth.session.setContactPolicy({ allowlist: [personIdForAgentId(aliceId)], defaultRule: 'deny' });
await aliceAuth.session.sendMessage({
  address: `person:${personIdForAgentId(externId)}`, body: { text: 'pushed to the foreign machine' },
  priority: 'normal', clientMessageId: 'connect-smoke-1',
});
await waitFor(
  () => outlines.some((line) => line['type'] === 'event'
    && JSON.stringify(line).includes('pushed to the foreign machine')),
  'the child is PUSHED the inbound message',
);
console.log('connect inbound push tests passed');

// --- outbound: child stdin {"to","body"} → SendMessage lands in alice's inbox ----

child.stdin.write(`${JSON.stringify({ 'to': aliceId, body: 'sent from the foreign machine' })}\n`);
await waitFor(() => outlines.some((line) => line['type'] === 'sent'), 'the child reports the send accepted');
const inbox = await aliceAuth.session.getInbox({});
if (inbox.kind !== 'ok') throw new Error('unreachable');
assert.ok(
  inbox.value.messages.some((message) => message.body.text === 'sent from the foreign machine'),
  "the child's outbound message lands in alice's inbox",
);
console.log('connect outbound send tests passed');

child.kill('SIGINT');
await new Promise((resolve) => child.once('exit', resolve));
await handle.close();
rmSync(scratch, { recursive: true, force: true });
console.log('nvk-connect smoke tests passed');
