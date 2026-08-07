import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverCli = path.resolve(here, '..', 'cli', 'nvk-server.ts');

test('doctor lists inert demo-person ids from fixture data without writing anything', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-server-doctor-'));
  const messagingPath = path.join(root, 'messaging.jsonl');
  writeFileSync(messagingPath, [
    JSON.stringify({ op: 'thread', direct: { pair: ['person_chris', 'person_pool2'] } }),
    JSON.stringify({ op: 'policy', contact: { personId: 'person_mockagent0' } }),
    JSON.stringify({ op: 'message', senderId: 'person_pool2', body: { text: 'person_pool9 is only prose' } }),
    JSON.stringify({ op: 'policy', contact: { personId: 'person_real' } }),
  ].join('\n') + '\n');
  const before = readFileSync(messagingPath, 'utf8');

  const output = execFileSync('npx', ['tsx', serverCli, 'doctor', '--root', root], {
    cwd: path.resolve(here, '..'),
    encoding: 'utf8',
  });
  const report = JSON.parse(output) as { inertDemoPersons: string[] };

  assert.deepEqual(report.inertDemoPersons, ['person_mockagent0', 'person_pool2']);
  assert.equal(readFileSync(messagingPath, 'utf8'), before, 'doctor never edits the evidence store');
  assert.deepEqual(readdirSync(root), ['messaging.jsonl'], 'doctor creates no config, token, or trace files');
});
