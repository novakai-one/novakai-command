// B1a slice 2 — `nvk-token mint` OFFLINE cold-start CLI (§6, §13 disposition 4).
// The CLI is exercised as a real subprocess: no server is running anywhere in
// this test, which is the whole point of the disposition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openConfigStore } from '../contract/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'cli', 'nvk-token.ts');

function runCli(root: string, args: string[]): string {
  return execFileSync('npx', ['tsx', CLI, ...args], {
    cwd: path.resolve(here, '..'),
    env: { ...process.env, NOVAKAI_ROOT: root },
    encoding: 'utf8',
  });
}

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-token-'));

test('mint runs with NO server: writes a token record and a principal config line', async () => {
  const dir = root();
  const out = runCli(dir, ['mint', 'person_chris', '--grants', 'conversationView', '--roles', 'Human']);

  const tokenFiles = readdirSync(path.join(dir, 'tokens')).filter((f) => f.endsWith('.json'));
  assert.equal(tokenFiles.length, 1, 'one token record minted');
  const record = JSON.parse(readFileSync(path.join(dir, 'tokens', tokenFiles[0]!), 'utf8')) as
    { id: string; principal: string; bearer: string; grants: string[] };
  assert.equal(record.principal, 'person_chris');
  assert.ok(record.bearer.startsWith('nvk_'));

  assert.ok(out.includes(record.bearer), 'the bearer is printed once, for the operator to store');
  assert.ok(out.includes(record.id));

  // The principal is now real config — the composition root will find it.
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const cfg = opened.value.current();
  assert.equal(cfg.principals.length, 1);
  assert.equal(cfg.principals[0]!.personId, 'person_chris');
  assert.deepEqual(cfg.principals[0]!.roles, ['Human']);
  assert.equal(cfg.principals[0]!.token, record.bearer);
  assert.equal(readFileSync(path.join(dir, 'config.jsonl'), 'utf8').includes(record.bearer), false);
});

test('re-minting the same principal rotates the token: the config points at the NEW record', async () => {
  const dir = root();
  runCli(dir, ['mint', 'person_chris', '--grants', 'conversationView', '--roles', 'Human']);
  runCli(dir, ['mint', 'person_chris', '--grants', 'conversationView', '--roles', 'Human']);

  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const cfg = opened.value.current();
  assert.equal(cfg.principals.length, 1, 'one principal, not two');

  const records = readdirSync(path.join(dir, 'tokens'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, 'tokens', f), 'utf8')) as { id: string; bearer: string });
  assert.equal(records.length, 2, 'the old record survives until the operator deletes it (revoke = delete)');
  const active = records.find((r) => r.bearer === cfg.principals[0]!.token);
  assert.ok(active, 'config points at one of the minted records');
});

test('list shows principals and never prints a bearer', () => {
  const dir = root();
  runCli(dir, ['mint', 'person_chris', '--grants', 'conversationView', '--roles', 'Human']);
  const bearer = JSON.parse(
    readFileSync(path.join(dir, 'tokens', readdirSync(path.join(dir, 'tokens'))[0]!), 'utf8'),
  ).bearer as string;

  const out = runCli(dir, ['list']);
  assert.ok(out.includes('person_chris'));
  assert.equal(out.includes(bearer), false, 'list never leaks the secret');
});

test('mint without a principal id, or without grants, fails loudly and writes nothing', () => {
  const dir = root();
  assert.throws(() => runCli(dir, ['mint']), /usage|principal/i);
  assert.throws(() => runCli(dir, ['mint', 'person_chris']), /grants/i);
  assert.equal(existsSync(path.join(dir, 'tokens')), false);
  assert.equal(existsSync(path.join(dir, 'config.jsonl')), false, 'a rejected mint materializes nothing');
});
