// S1 — cross-process CAS: the expectedVersion check must happen INSIDE the
// mutation lock (engine-level compare-then-append). Two synchronized child
// processes race an update at the same expectedVersion; exactly one may win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { composeHandle, createObject, mintClientOpId } from '../contract/index.js';

const run = promisify(execFile);
const CHILD = path.resolve('dist/tests/cas-child.js');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, `child never signalled ${file}`);
    await sleep(5);
  }
}

interface ChildOutcome { ok: boolean; version?: number; code?: string }

test('S1: two-process concurrent update at the same expectedVersion → exactly one wins, loser gets CasConflict', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-cas-race-'));
  try {
    for (let round = 0; round < 3; round += 1) {
      const id = `settings_race_${round}`;
      const h = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_setup' });
      const created = await createObject(h, {
        kind: 'settings', id, schemaVersion: 1, createdAt: new Date().toISOString(),
        permissionLevel: 'private', createdBy: 'person_setup', key: id, value: 0,
      }, mintClientOpId());
      assert.equal(created.ok, true);

      const opA = `op_race_${round}_a`;
      const opB = `op_race_${round}_b`;
      const spawn = (op: string) => run(process.execPath, [CHILD, root, id, '1', op]);
      const pA = spawn(opA);
      const pB = spawn(opB);
      await waitFor(path.join(root, `ready_${opA}`));
      await waitFor(path.join(root, `ready_${opB}`));
      writeFileSync(path.join(root, 'go'), 'go');
      const [rA, rB] = await Promise.all([pA, pB]);
      const outcomes = [rA, rB].map((r) => JSON.parse(r.stdout.trim()) as ChildOutcome);

      const wins = outcomes.filter((o) => o.ok);
      const conflicts = outcomes.filter((o) => !o.ok && o.code === 'CasConflict');
      assert.equal(wins.length, 1, `round ${round}: exactly one process may commit (got ${JSON.stringify(outcomes)})`);
      assert.equal(conflicts.length, 1, `round ${round}: the loser must get a typed CasConflict (got ${JSON.stringify(outcomes)})`);
      assert.equal(wins[0].version, 2);

      // no double-append: the store holds exactly two lines for this id (create + one update)
      const lines = readFileSync(path.join(root, 'settings.jsonl'), 'utf8')
        .split('\n').filter((l) => l.includes(`"id":"${id}"`));
      assert.equal(lines.length, 2, `round ${round}: losing process must not append`);

      rmSync(path.join(root, 'go'), { force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
