// B3e lane A — A-01: `nvk runtime doctor` is OQ-01's composition again, and the
// cutover report moves out of it (NVK-KIMI-092 §4, the ruling's one defect).
//
// Two faults, one command:
//
//   1. `--cutover` added a flag to a ratified command (CL-A: adding a flag
//      requires an amendment; none exists), and emitted
//      `command: "runtime doctor --cutover"` — an argv-shaped value derived
//      from a ratified command name, so no consumer could separate it from
//      `runtime.doctor` by X-1 membership. Every other out-of-B3e extra
//      separates for free; this one could not, by construction.
//   2. `doctor` called a wire method `b3.runtime.doctor` returning
//      `RuntimeDoctorReport`, where OQ-01 ruled the value is `RuntimeStatus`
//      and the command "calls `RuntimeHostQueries.getRuntimeStatus` and
//      nothing else".
//
// These are driven against a LIVE runtime on purpose. The hermetic no-token
// harness in `b3e-cli-command.test.ts` proves which `command` a call emits, but
// every call fails `RuntimeUnavailable` before a value exists — so it can say
// nothing about the value TYPE, which is the whole of OQ-01.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { RULED_COMMANDS, UNRULED_COMMANDS } from '../../core/b3/cli-shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope { readonly command?: string; readonly value?: Record<string, unknown> }

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

/** A live Runtime on an OS-picked port, over a throwaway root. */
async function withRuntime(
  label: string, work: (where: readonly string[], root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `nvk-b3e-${label}-`));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    await work(['--root', root, '--port', String(host.port)], root);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** OQ-01: `T = RuntimeStatus`. Every member, so a near-miss shape cannot pass. */
const RUNTIME_STATUS_FIELDS = [
  'activeEpochId', 'state', 'version', 'startedAt', 'recoveryRequiredCount',
  'liveAgentRunCount', 'liveTerminalSessionCount', 'attachedControllerCount',
  'ownedByThisProcess',
] as const;

/** What `RuntimeDoctorReport` carries and `RuntimeStatus` does not. */
const DOCTOR_REPORT_ONLY_FIELDS = [
  'leaseHolderPid', 'leaseHolderAlive', 'activeEpoch', 'supersededEpochs',
  'sessionsNeedingRecovery', 'findings',
] as const;

test('nvk runtime doctor answers with RuntimeStatus, per OQ-01', async () => {
  await withRuntime('doctor', async (where) => {
    const run = await runNvk(['runtime', 'doctor', '--json', ...where]);
    assert.equal(run.code, 0, `doctor exited ${String(run.code)}: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'runtime.doctor');
    const value = envelope.value ?? {};
    for (const field of RUNTIME_STATUS_FIELDS) {
      assert.ok(field in value, `RuntimeStatus.${field} missing: ${JSON.stringify(value)}`);
    }
    for (const field of DOCTOR_REPORT_ONLY_FIELDS) {
      assert.equal(field in value, false,
        `doctor still answers with RuntimeDoctorReport (${field} present)`);
    }
  });
});

test('a healthy runtime is exit 0, and an unhealthy one is honest data — not an error', async () => {
  // OQ-01: "Exit is 0 whenever the query succeeds." The failure this guards is
  // a doctor that maps a recovery state onto a non-zero exit, which turns every
  // operator's `nvk runtime doctor || echo broken` into a lie in both
  // directions.
  await withRuntime('doctor-exit', async (where) => {
    const run = await runNvk(['runtime', 'doctor', '--json', ...where]);
    assert.equal(run.code, 0);
    const value = envelopeOf(run).value ?? {};
    assert.equal(typeof value['recoveryRequiredCount'], 'number');
  });
});

test('the ratified flag set of runtime doctor is empty — --cutover changes nothing', async () => {
  // CL-A. Before this, `--cutover` short-circuited the command into a different
  // value type with a different `command` string. The flag is not ratified, so
  // the ruled command must answer identically with or without it.
  await withRuntime('doctor-flag', async (where) => {
    const plain = envelopeOf(await runNvk(['runtime', 'doctor', '--json', ...where]));
    const flagged = envelopeOf(await runNvk(['runtime', 'doctor', '--cutover', '--json', ...where]));
    assert.equal(flagged.command, 'runtime.doctor');
    assert.deepEqual(Object.keys(flagged.value ?? {}).sort(),
      Object.keys(plain.value ?? {}).sort());
  });
});

test('the human doctor states the controller truth and names recovery when non-zero', async () => {
  // FZ-CLI-SCHEMA-007 + OQ-01's human clause. `--json` is the contract; the
  // human line is what an operator reads, and it must not be less honest.
  await withRuntime('doctor-human', async (where) => {
    const run = await runNvk(['runtime', 'doctor', ...where]);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /controller/iu, `no controller truth: ${run.out}`);
    assert.match(run.out, /recovery/iu, `no recovery truth: ${run.out}`);
  });
});

test('the two command vocabularies are disjoint, and the argv-shaped member is gone', () => {
  // §0 consequence 5, as a runtime predicate: `command ∈ X-1's closed set` ⟺
  // the invocation was a ratified §17.1 command. That only holds if no member
  // is in both lists, and if no extra is spelled as a ratified command plus a
  // flag — which is precisely what `"runtime doctor --cutover"` was.
  const ruled = new Set<string>(RULED_COMMANDS);
  for (const extra of UNRULED_COMMANDS) {
    assert.equal(ruled.has(extra), false, `${extra} is in both vocabularies`);
    assert.equal(extra.includes('--'), false, `${extra} spells an extra as a ratified flag`);
  }
});
