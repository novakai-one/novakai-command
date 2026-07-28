import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  mintClientOpId,
  mintToken,
  type ArtifactId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
} from '../contract/index.js';

const cli = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../cli/nvk-artifact.js',
);

async function waitUntil(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('artifact byte durability completes outside the held Foundation global lock', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-lock-'));
  const root = path.join(workspace, '.novakai');
  const lockDir = path.join(root, 'lock');
  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'live-test-holder' })}\n`,
    );
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
      lockTimeoutMs: 50,
    }).operations;
    const bytes = Buffer.from('bytes finish before lock contention', 'utf8');

    const result = await artifacts.putArtifact({
      bytes,
      mimeType: 'text/plain',
    }, mintClientOpId());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'LockBusy');
    const byteFiles = readdirSync(path.join(root, 'artifacts'));
    assert.equal(byteFiles.length, 1);
    assert.equal(byteFiles[0].startsWith('artifact_'), true);
    assert.deepEqual(
      readFileSync(path.join(root, 'artifacts', byteFiles[0])),
      bytes,
    );
    assert.equal(existsSync(path.join(root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('orphan sweep cannot delete bytes owned by a live publication', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-live-sweep-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'live-publication.txt');
  const lockDir = path.join(root, 'lock');
  let putProcess: ReturnType<typeof spawn> | undefined;
  let resumed = false;
  try {
    const bytes = Buffer.from('live publication survives sweep', 'utf8');
    writeFileSync(source, bytes);
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'test-global-owner' })}\n`,
    );

    putProcess = spawn(process.execPath, [
      cli,
      'put',
      source,
      '--root', root,
      '--token', token.bearer,
      '--mime-type', 'text/plain',
      '--client-op-id', mintClientOpId(),
      '--lock-timeout-ms', '5000',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    putProcess.stdout?.setEncoding('utf8');
    putProcess.stderr?.setEncoding('utf8');
    putProcess.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    putProcess.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      putProcess?.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const bytesRoot = path.join(root, 'artifacts');
    let artifactId = '';
    await waitUntil(() => {
      if (!existsSync(bytesRoot)) return false;
      artifactId = readdirSync(bytesRoot).find(
        (name) => name.startsWith('artifact_'),
      ) ?? '';
      return artifactId.length > 0
        && existsSync(path.join(
          bytesRoot,
          '.publication-locks',
          `${artifactId}.lock`,
          'owner.json',
        ));
    }, 'renamed bytes under a live publication lease');

    assert.notEqual(putProcess.pid, undefined);
    if (putProcess.pid === undefined) return;
    process.kill(putProcess.pid, 'SIGSTOP');
    await waitUntil(() => {
      const state = spawnSync(
        'ps',
        ['-o', 'state=', '-p', String(putProcess?.pid)],
        { encoding: 'utf8' },
      ).stdout.trim();
      return state.startsWith('T');
    }, 'put process to enter the stopped state');

    rmSync(lockDir, { recursive: true, force: true });
    const host = composeArtifacts({
      root,
      principal: 'sys_reconciler',
      lockTimeoutMs: 30,
    });
    const swept = await host.boot.sweepOrphans();
    const leasePath = path.join(
      bytesRoot,
      '.publication-locks',
      `${artifactId}.lock`,
    );
    const bytesStillPresentDuringPublication = existsSync(
      path.join(bytesRoot, artifactId),
    );
    const leaseStillPresent = existsSync(leasePath);

    process.kill(putProcess.pid, 'SIGCONT');
    resumed = true;
    const outcome = await exited;
    const published = outcome.code === 0
      ? JSON.parse(stdout) as { id: string }
      : null;
    const fetched = published
      ? await host.http.getArtifactBytes(published.id as ArtifactId)
      : null;

    assert.equal(swept.ok, false);
    if (!swept.ok) {
      assert.equal(swept.error.code, 'ArtifactPublicationBusy');
    }
    assert.equal(bytesStillPresentDuringPublication, true);
    assert.equal(leaseStillPresent, true);
    assert.equal(outcome.code, 0, stderr);
    assert.equal(published?.id, artifactId);
    assert.equal(fetched?.ok, true);
    if (fetched?.ok && !('absent' in fetched.value)) {
      assert.deepEqual(Buffer.from(fetched.value), bytes);
    }
  } finally {
    if (putProcess && putProcess.exitCode === null) {
      if (!resumed && putProcess.pid !== undefined) {
        process.kill(putProcess.pid, 'SIGCONT');
      }
      putProcess.kill('SIGTERM');
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('same-operation concurrent puts serialize publication integrity', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-publication-'));
  try {
    const mismatchedRoot = path.join(workspace, 'mismatched', '.novakai');
    const firstHost = composeArtifacts({
      root: mismatchedRoot,
      principal: 'person_chris',
    });
    const secondHost = composeArtifacts({
      root: mismatchedRoot,
      principal: 'person_chris',
    });
    const mismatchedOp = mintClientOpId();
    const largeBytes = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const smallBytes = Buffer.from('different', 'utf8');

    const mismatched = await Promise.all([
      firstHost.operations.putArtifact({
        bytes: largeBytes,
        mimeType: 'application/octet-stream',
      }, mismatchedOp),
      secondHost.operations.putArtifact({
        bytes: smallBytes,
        mimeType: 'text/plain',
      }, mismatchedOp),
    ]);

    assert.equal(mismatched.filter((result) => result.ok).length, 1);
    assert.equal(mismatched.filter((result) => !result.ok).length, 1);
    const conflict = mismatched.find((result) => !result.ok);
    assert.equal(conflict?.ok, false);
    if (conflict && !conflict.ok) {
      assert.equal(conflict.error.code, 'ArtifactIdempotencyConflict');
    }
    const winner = mismatched.find((result) => result.ok);
    assert.equal(winner?.ok, true);
    if (!winner?.ok) return;
    const published = await firstHost.http.getArtifactBytes(winner.value.id);
    assert.equal(published.ok, true);
    if (!published.ok || 'absent' in published.value) return;
    assert.equal(published.value.byteLength, winner.value.byteSize);

    const matchingRoot = path.join(workspace, 'matching', '.novakai');
    const matchingHost = composeArtifacts({
      root: matchingRoot,
      principal: 'person_chris',
    });
    const matchingOp = mintClientOpId();
    const matchingInput = {
      bytes: Buffer.from('same publication', 'utf8'),
      mimeType: 'text/plain',
    };
    const matching = await Promise.all([
      matchingHost.operations.putArtifact(matchingInput, matchingOp),
      matchingHost.operations.putArtifact(matchingInput, matchingOp),
    ]);
    assert.equal(matching.every((result) => result.ok), true);
    if (!matching[0].ok || !matching[1].ok) return;
    assert.deepEqual(matching[1].value, matching[0].value);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('artifact publication recovers dead and abandoned leases', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-stale-lease-'));
  try {
    for (const scenario of ['dead-owner', 'ownerless'] as const) {
      const root = path.join(workspace, scenario, '.novakai');
      const host = composeArtifacts({
        root,
        principal: 'person_chris',
        lockTimeoutMs: 100,
      });
      const clientOpId = mintClientOpId();
      const input = {
        bytes: Buffer.from(`recover ${scenario}`, 'utf8'),
        mimeType: 'text/plain',
      };
      const created = await host.operations.putArtifact(input, clientOpId);
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const lockDir = path.join(
        root,
        'artifacts',
        '.publication-locks',
        `${created.value.id}.lock`,
      );
      mkdirSync(lockDir, { recursive: true });
      if (scenario === 'dead-owner') {
        writeFileSync(
          path.join(lockDir, 'owner.json'),
          `${JSON.stringify({ pid: 999999, token: 'dead-owner' })}\n`,
        );
      } else {
        const staleAt = new Date(Date.now() - 60_000);
        utimesSync(lockDir, staleAt, staleAt);
      }

      const retried = await host.operations.putArtifact(input, clientOpId);

      assert.equal(retried.ok, true);
      assert.equal(existsSync(lockDir), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
