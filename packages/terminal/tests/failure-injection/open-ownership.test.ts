// Finding 1 (NVK-KIMI-021 SEVERE): a PTY must never exist without a durable
// owner, and an interrupted open must never become a second PTY.
//
// §13.5 gives the shape: `terminal reserved/live`, proof = "Terminal fingerprint
// matches operation", retry = "adopt same PTY or report recovery". §25-B3a
// requires zero duplicate PTY ownership; red gates 25 and 28 say the same thing
// from the other side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3fail, b3ok, mintRuntimeEpochId,
  type B3Result, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import {
  composeTerminal, type PtyHandle, type PtyHost, type PtyLaunchSpec,
  type RuntimeEpochFence, type TerminalContract,
} from '../../contract/index.js';
import type { TerminalSession } from '../../contract/records.js';
import { createFakePtyHost, type FakePtyHost } from '../../adapters/pty-host/fake.js';
import { humanContext, movableClock, runtimeContext, unwrap } from '../harness.js';

const SHELL = {
  owner: { kind: 'plain-shell', shellInstanceId: 'shell_1' },
  launchAuthorityRef: 'plain-shell',
  launchFingerprint: 'plain-shell:/bin/zsh',
  workingDirectory: '/tmp',
  columns: 80,
  rows: 24,
} as const;

/** Every session line ever appended, in order — the durable journal itself. */
function appendedSessions(root: string): TerminalSession[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, 'terminalSessions.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      // Identity lives in the envelope, the domain fields in the payload (§18.2).
      const record = JSON.parse(line) as {
        envelope: { id: string; kind: string };
        payload: Record<string, unknown>;
      };
      return { ...record.payload, ...record.envelope } as unknown as TerminalSession;
    });
}

/** The current state of each session, as a reader of the store would see it. */
function sessionsOnDisk(root: string): TerminalSession[] {
  const latest = new Map<string, TerminalSession>();
  for (const payload of appendedSessions(root)) latest.set(payload.id, payload);
  return [...latest.values()];
}

function fenceFor(epochId: RuntimeEpochId): RuntimeEpochFence {
  return {
    activeEpochId: () => epochId,
    assertActive(candidate) {
      if (candidate !== undefined && candidate !== epochId) {
        return b3fail({
          code: 'StaleRuntimeEpoch', message: 'epoch is no longer active',
          details: { received: candidate, active: epochId }, retryable: true,
        });
      }
      return b3ok(epochId);
    },
  };
}

/** A runtime host over an existing store root — i.e. "the same machine, later". */
function runtimeOver(
  root: string, epochId: RuntimeEpochId, ptyHost: PtyHost,
): TerminalContract {
  return composeTerminal({ root, epochFence: fenceFor(epochId), clock: movableClock(), ptyHost });
}

/** A host that reaches the spawn and never returns — the named crash window. */
function hangingPtyHost(onReached: () => void): PtyHost {
  return {
    async start(): Promise<B3Result<PtyHandle>> {
      onReached();
      return new Promise<B3Result<PtyHandle>>(() => undefined);
    },
    // The lie a PID probe cannot catch: something IS alive at that ref.
    probe: () => true,
  };
}

test('no PTY is ever started before a durable record owns it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-open-owner-'));
  const seenAtSpawn: TerminalSession[][] = [];
  const inner: FakePtyHost = createFakePtyHost();
  // The one moment that matters is INSIDE start(): what does the store say?
  const watching: PtyHost = {
    async start(spec: PtyLaunchSpec): Promise<B3Result<PtyHandle>> {
      seenAtSpawn.push(sessionsOnDisk(root));
      return inner.start(spec);
    },
    probe: (processRef: string) => inner.probe(processRef),
  };
  const terminal = runtimeOver(root, mintRuntimeEpochId(), watching);
  try {
    const opened = unwrap(await terminal.openManagedTerminal(humanContext(), SHELL), 'open');

    assert.equal(seenAtSpawn.length, 1, 'the PTY host was not asked to start exactly once');
    const durableAtSpawn = seenAtSpawn[0]!;
    assert.equal(durableAtSpawn.length, 1,
      'a PTY was started with no durable record to own it');
    assert.equal(durableAtSpawn[0]!.id, opened.id, 'the pre-spawn record is not the opened one');
    assert.equal(durableAtSpawn[0]!.launchFingerprint, SHELL.launchFingerprint,
      'the pre-spawn record does not identify WHAT is being launched');
    assert.equal(durableAtSpawn[0]!.status, 'starting',
      'the record that owns the spawn does not say a launch is in flight');

    // The whole ladder is durable, in order — §13.5's reserved → live stages.
    assert.deepEqual(
      appendedSessions(root).filter((item) => item.id === opened.id).map((item) => item.status),
      ['reserved', 'starting', 'live'],
    );
    assert.equal(opened.status, 'live');
  } finally {
    await terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a retry of an interrupted open never starts a second PTY', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-open-retry-'));
  const epochId = mintRuntimeEpochId();
  let reachedSpawn: () => void = () => undefined;
  const spawnReached = new Promise<void>((resolve) => { reachedSpawn = resolve; });
  const dying = runtimeOver(root, epochId, hangingPtyHost(() => reachedSpawn()));
  const context = humanContext(); // ONE caller-minted clientOpId, used twice

  void dying.openManagedTerminal(context, SHELL);
  await spawnReached;

  // A new runtime host over the same store — the retry after the restart.
  const freshPty = createFakePtyHost();
  const reborn = runtimeOver(root, epochId, freshPty);
  try {
    const retried = await reborn.openManagedTerminal(context, SHELL);

    assert.equal(freshPty.started.length, 0,
      'the retry started a SECOND PTY for the same operation');
    assert.equal(retried.ok, false, 'an uncertain PTY effect was reported as success');
    if (retried.ok) return;
    assert.equal(retried.error.code, 'RecoveryRequired');
    const durable = sessionsOnDisk(root);
    assert.equal(durable.length, 1, 'the retry minted a second session record');
    assert.equal(durable[0]!.launchFingerprint, SHELL.launchFingerprint);
  } finally {
    await reborn.dispose();
    await dying.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a retry of a COMPLETED open returns the same session, not a new one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-open-replay-'));
  const ptyHost = createFakePtyHost();
  const terminal = runtimeOver(root, mintRuntimeEpochId(), ptyHost);
  const context = humanContext();
  try {
    const first = unwrap(await terminal.openManagedTerminal(context, SHELL), 'open');
    const again = unwrap(await terminal.openManagedTerminal(context, SHELL), 'retry');

    assert.equal(again.id, first.id, 'the retry opened a different session');
    assert.equal(ptyHost.started.length, 1, 'the retry started a second PTY');
    assert.equal(sessionsOnDisk(root).length, 1);
  } finally {
    await terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a launch that never returned is settled honestly, not left recoverable forever', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-open-unlaunched-'));
  const deadEpoch = mintRuntimeEpochId();
  let reachedSpawn: () => void = () => undefined;
  const spawnReached = new Promise<void>((resolve) => { reachedSpawn = resolve; });
  const dying = runtimeOver(root, deadEpoch, hangingPtyHost(() => reachedSpawn()));
  void dying.openManagedTerminal(humanContext(), SHELL);
  await spawnReached;

  const activeEpochId = mintRuntimeEpochId();
  const reborn = runtimeOver(root, activeEpochId, createFakePtyHost());
  try {
    const reconciled = unwrap(
      await reborn.system.reconcileAfterRestart(runtimeContext(activeEpochId), { activeRuntimeEpochId: activeEpochId }),
      'reconcile',
    );
    assert.equal(reconciled.reconciledSessionIds.length, 1);
    // Nothing was ever learned about a process, so "it may still be out there"
    // would be an invented certainty (red gate 27), even with a probe saying yes.
    assert.equal(sessionsOnDisk(root)[0]!.status, 'failed');
  } finally {
    await reborn.dispose();
    await dying.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
