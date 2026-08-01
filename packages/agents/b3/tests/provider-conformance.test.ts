// Provider conformance (§24.2): one suite, three real adapters.
//
// The point is not that the adapters agree. It is that where they DISAGREE,
// each one says so honestly — §14's "no adapter may claim parity by translating
// an unsupported command into a different effect". A suite that only checked
// sameness would pass a set of adapters that all lie identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintAgentRunId, mintProviderSessionId, mintResolvedLaunchPlanId,
  mintTerminalSessionId, nowIsoUtc,
  type ProviderSessionId, type RecordVersion,
} from '@novakai/foundation/contract';
import {
  createProviderAdapters, PROVIDER_KINDS,
  type InteractiveProviderAdapter, type ProviderKind, type ResolvedLaunchPlan,
} from '../contract/index.js';
import { createCodexAdapter } from '../adapters/providers/codex.js';
import { createKimiAdapter } from '../adapters/providers/kimi.js';
import { roleInput } from './harness.js';

const adapters = createProviderAdapters();

function planFor(provider: ProviderKind, workingDirectory: string): ResolvedLaunchPlan {
  const role = roleInput();
  return {
    kind: 'resolvedLaunchPlan',
    id: mintResolvedLaunchPlanId(),
    schemaVersion: 1,
    recordVersion: 1 as RecordVersion,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: 'person_chris' as never,
    lastMutation: { state: 'legacy-no-trace' },
    agentId: 'agent_00000000-0000-4000-8000-000000000000' as never,
    roleProfile: { id: 'agentRole_x', version: 1, digest: 'digest' },
    provider,
    modelId: 'opus',
    effort: 'high',
    workingDirectory,
    skills: role.skillRefs,
    hooks: [],
    instructions: [],
    skillsConfirmationGate: role.skillsConfirmationGate,
    executionPolicy: {
      policyRef: role.executionPolicyRef,
      commandScopes: [], filesystemScopes: [], networkScopes: [],
      enforcement: 'advisory', limitations: [],
    },
    spawnPolicy: role.spawnPolicy,
    lifecyclePolicy: role.lifecyclePolicy,
    supervisionPolicy: role.supervisionPolicy,
    budgetPolicy: role.budgetPolicy,
    resolutionFingerprint: 'fingerprint',
  };
}

const launchInput = (reserved: ProviderSessionId, workingDirectory: string) => ({
  workingDirectory,
  columns: 120,
  rows: 40,
  reservedProviderSessionId: reserved,
  runtimeEnvironment: { NVK_AGENT_RUN_ID: 'agentRun_x' },
});

test('every adapter names the provider it is, and probes a real version', async () => {
  for (const provider of PROVIDER_KINDS) {
    const adapter = adapters[provider];
    assert.equal(adapter.provider, provider);
    const report = await adapter.discoverCapabilities();
    assert.equal(report.provider, provider);
    assert.notEqual(report.testedProviderVersion, '',
      `${provider} reported no tested version`);
  }
});

test('every capability answer carries evidence, never a bare claim', async () => {
  const named = [
    'resume', 'fresh', 'compact', 'modelChange', 'effortChange', 'interrupt',
    'safeMessageBoundary', 'transcriptDiscovery', 'usage', 'screenContext',
    'nativeSubagentObservation',
  ] as const;
  for (const provider of PROVIDER_KINDS) {
    const report = await adapters[provider].discoverCapabilities();
    for (const name of named) {
      const capability = report[name];
      assert.notEqual(capability.evidence.trim(), '',
        `${provider}.${name} claimed ${capability.support} with no evidence (red gate 27)`);
      assert.equal(
        ['native', 'replacement-required', 'advisory', 'unsupported', 'unavailable']
          .includes(capability.support),
        true, `${provider}.${name} reported an unknown support level`);
    }
  }
});

test('no adapter claims a native mid-session model change', async () => {
  // B1's OD-C3 spike found no verified interactive mechanism for any of the
  // three. An adapter that claimed `native` here would be inventing parity.
  for (const provider of PROVIDER_KINDS) {
    const report = await adapters[provider].discoverCapabilities();
    assert.notEqual(report.modelChange.support, 'native',
      `${provider} claimed a native mid-session model change without evidence`);
    const outcome = await adapters[provider].applyControl({
      providerSessionId: mintProviderSessionId(),
      control: { name: 'model', value: 'sonnet' },
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.notEqual(outcome.value.kind, 'applied-native',
        `${provider} reported an effect it cannot perform`);
    }
  }
});

test('an unsupported control is refused by name, not translated', async () => {
  for (const provider of PROVIDER_KINDS) {
    const outcome = await adapters[provider].applyControl({
      providerSessionId: mintProviderSessionId(),
      control: { name: 'provider-setting', value: 'anything' },
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.kind, 'unsupported',
        `${provider} accepted a control it does not implement`);
    }
  }
});

test('a launch never carries the reserved id into argv as a bare string', async () => {
  const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-launch-'));
  try {
    for (const provider of PROVIDER_KINDS) {
      const reserved = mintProviderSessionId();
      const built = await adapters[provider].buildLaunch(
        planFor(provider, workingDirectory), launchInput(reserved, workingDirectory),
      );
      if (!built.ok) continue; // an absent CLI is a legitimate answer
      assert.equal(built.value.workingDirectory, workingDirectory);
      assert.equal(built.value.argv.includes(reserved), false,
        `${provider} put a Novakai ProviderSessionId on the command line (red gate 3)`);
      assert.equal(built.value.environment['NVK_AGENT_RUN_ID'], 'agentRun_x',
        `${provider} dropped the runtime environment a child needs to authenticate`);
      assert.notEqual(built.value.launchFingerprint, '',
        `${provider} produced no launch fingerprint for recovery to match`);
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('claude turns the reservation into the provider\'s own conversation id', async () => {
  const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-claude-'));
  try {
    const reserved = mintProviderSessionId();
    const built = await adapters.claude.buildLaunch(
      planFor('claude', workingDirectory), launchInput(reserved, workingDirectory),
    );
    if (!built.ok) return; // claude is not installed on this machine
    const uuid = reserved.replace('sess_', '');
    assert.equal(built.value.argv.includes('--session-id'), true);
    assert.equal(built.value.argv.includes(uuid), true,
      'claude accepts a pre-assigned session id and the adapter must use it');

    const discovered = await adapters.claude.discoverSession({
      agentRunId: mintAgentRunId(),
      expectedProviderSessionId: reserved,
      terminalSessionId: mintTerminalSessionId(),
      launchFingerprint: built.value.launchFingerprint,
    });
    assert.equal(discovered.ok, true);
    if (discovered.ok) {
      // §5.4: an exact echo. Here it is exact by construction.
      assert.equal(discovered.value.providerSessionId, reserved);
      assert.equal(discovered.value.providerNativeSessionId, uuid);
      assert.equal(discovered.value.live, 'live');
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('a discovery that finds nothing says unknown rather than guessing', async () => {
  // The failure this prevents: another codex or kimi on the machine finishing
  // first and having its session adopted as ours.
  const empty = mkdtempSync(path.join(tmpdir(), 'nvk-empty-sessions-'));
  try {
    const cases: readonly InteractiveProviderAdapter[] = [
      createCodexAdapter({ sessionRoot: empty, discoveryWindowMs: 50, cliPath: '/bin/echo' }),
      createKimiAdapter({ sessionRoot: empty, discoveryWindowMs: 50, cliPath: '/bin/echo' }),
    ];
    for (const adapter of cases) {
      const reserved = mintProviderSessionId();
      const discovered = await adapter.discoverSession({
        agentRunId: mintAgentRunId(),
        expectedProviderSessionId: reserved,
        terminalSessionId: mintTerminalSessionId(),
        launchFingerprint: 'x',
      });
      assert.equal(discovered.ok, true);
      if (!discovered.ok) continue;
      assert.equal(discovered.value.providerSessionId, reserved,
        `${adapter.provider} must still echo the reserved id`);
      assert.equal(discovered.value.providerNativeSessionId, '',
        `${adapter.provider} invented a native session id it never saw`);
      assert.equal(discovered.value.live, 'unknown');
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a session file written after launch IS discovered, with its locator', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-codex-sessions-'));
  try {
    const adapter = createCodexAdapter({
      sessionRoot: root, discoveryWindowMs: 1_000, cliPath: '/bin/echo',
    });
    const reserved = mintProviderSessionId();
    // Launch first, so the adapter records the moment discovery may look from.
    await adapter.buildLaunch(planFor('codex', root), launchInput(reserved, root));
    const day = path.join(root, '2026', '08', '01');
    mkdirSync(day, { recursive: true });
    const native = '019fa7b4-1111-7111-8111-111111111111';
    const rollout = path.join(day, `rollout-2026-08-01T10-00-00-${native}.jsonl`);
    writeFileSync(rollout, '{}\n');

    const discovered = await adapter.discoverSession({
      agentRunId: mintAgentRunId(),
      expectedProviderSessionId: reserved,
      terminalSessionId: mintTerminalSessionId(),
      launchFingerprint: 'x',
    });
    assert.equal(discovered.ok, true);
    if (discovered.ok) {
      assert.equal(discovered.value.providerNativeSessionId, native);
      assert.equal(discovered.value.live, 'live');
      assert.equal(discovered.value.evidence.some((item) => item.includes(rollout)), true,
        'discovery must name the file it believed');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session file written BEFORE launch is never adopted', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-codex-stale-'));
  try {
    const day = path.join(root, '2026', '07', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      path.join(day, 'rollout-2026-07-01T10-00-00-019f0000-2222-7222-8222-222222222222.jsonl'),
      '{}\n',
    );
    // Only now does the Run launch, so that rollout belongs to somebody else.
    const adapter = createCodexAdapter({
      sessionRoot: root, discoveryWindowMs: 50, cliPath: '/bin/echo',
    });
    const reserved = mintProviderSessionId();
    await new Promise((settle) => { setTimeout(settle, 1_100); });
    await adapter.buildLaunch(planFor('codex', root), launchInput(reserved, root));

    const discovered = await adapter.discoverSession({
      agentRunId: mintAgentRunId(),
      expectedProviderSessionId: reserved,
      terminalSessionId: mintTerminalSessionId(),
      launchFingerprint: 'x',
    });
    assert.equal(discovered.ok, true);
    if (discovered.ok) {
      assert.equal(discovered.value.providerNativeSessionId, '',
        'a pre-existing session was adopted as this Run\'s');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume without a native session id is refused, not silently made fresh', async () => {
  const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-resume-'));
  try {
    for (const provider of PROVIDER_KINDS) {
      const adapter = adapters[provider];
      const built = await adapter.buildContinuation({
        mode: 'resume',
        oldSession: {
          providerSessionId: mintProviderSessionId(),
          providerNativeSessionId: '',
          live: 'unknown',
          evidence: [],
        },
        launchPlan: planFor(provider, workingDirectory),
        workingDirectory,
        columns: 120,
        rows: 40,
        runtimeEnvironment: {},
      });
      assert.equal(built.ok, false,
        `${provider} started a FRESH session when asked to resume an unknown one`);
      if (!built.ok) assert.equal(built.error.code, 'UnsupportedOperation');
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('an unverified compact is refused by the adapters that cannot do it', async () => {
  const workingDirectory = mkdtempSync(path.join(tmpdir(), 'nvk-compact-'));
  try {
    for (const provider of ['codex', 'kimi'] as const) {
      const report = await adapters[provider].discoverCapabilities();
      assert.equal(report.compact.support, 'unavailable',
        `${provider} claimed a compact mechanism nobody probed`);
      const built = await adapters[provider].buildContinuation({
        mode: 'compact',
        oldSession: {
          providerSessionId: mintProviderSessionId(),
          providerNativeSessionId: 'native-id',
          live: 'live',
          evidence: [],
        },
        launchPlan: planFor(provider, workingDirectory),
        workingDirectory,
        columns: 120,
        rows: 40,
        runtimeEnvironment: {},
      });
      assert.equal(built.ok, false, `${provider} built a compact launch it cannot perform`);
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('every adapter finds the canonical confirmation line in its own output', async () => {
  const marker = 'SKILLS-CONFIRMED:';
  const noisy = [
    '[2m? for shortcuts[0m',
    'thinking…',
    `  ${marker} ["tdd@v1#abc"]`,
    '',
  ].join('\n');
  for (const provider of PROVIDER_KINDS) {
    const found = adapters[provider].findConfirmationLine({ text: noisy }, marker);
    assert.equal(found, `${marker} ["tdd@v1#abc"]`,
      `${provider} could not find the confirmation line in its own output`);
  }
});

test('the LAST confirmation wins, so a prompt cannot confirm itself', async () => {
  const marker = 'SKILLS-CONFIRMED:';
  // Turn 1 echoes the instruction (which contains the marker), then the model
  // answers. Reading the first match would accept the prompt as the reply.
  const echoed = [
    `reply with exactly: ${marker} ["<token>"]`,
    `${marker} ["tdd@v1#abc"]`,
  ].join('\n');
  for (const provider of PROVIDER_KINDS) {
    const found = adapters[provider].findConfirmationLine({ text: echoed }, marker);
    assert.equal(found, `${marker} ["tdd@v1#abc"]`);
  }
});

test('a turn is delivered as ONE line, because a composer treats a newline as a newline', async () => {
  // Driving the real `claude` 2.1.219: a multi-line turn arrives, echoes into
  // the composer, and is never sent — the embedded newlines make it a multi-line
  // draft, and the Enter that follows adds another line instead of submitting.
  // The same text as one line, with Enter after it, is answered in seconds.
  // This is the whole reason a governed spawn could not reach `ready` against a
  // real provider (hold-out B3).
  const enter = String.fromCharCode(13);
  const turn = 'You are a governed agent.\n\nTASK: say BANANA\n  1. tdd@v1#abc\n';
  for (const provider of PROVIDER_KINDS) {
    const wire = adapters[provider].submitTurn(turn);
    assert.equal(wire.endsWith(enter), true, `${provider} never presses Enter`);
    assert.equal(wire.slice(0, -1).includes('\n'), false,
      `${provider} sends a newline mid-turn, which a TUI composer will not submit`);
    // Nothing may be lost in the flattening: every word still arrives.
    for (const word of ['governed', 'BANANA', 'tdd@v1#abc']) {
      assert.equal(wire.includes(word), true, `${provider} dropped "${word}" from the turn`);
    }
  }
});
