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

test('a turn arrives with its lines intact', async () => {
  // This test used to assert the OPPOSITE — that every newline was replaced
  // before the turn went out — on the belief that a composer treats an embedded
  // newline as "add a line" and never submits.
  //
  // That belief was never measured. It is false, and the flattening it justified
  // did two kinds of damage: it silently rewrote code, JSON, Markdown and
  // numbered instructions before sending them, so what the agent was asked to do
  // was not what the operator wrote; and `kimi` submits the flattened long turn
  // about a third of the time against seven eighths for the same content with
  // its lines intact. See `adapters/providers/turn-delivery.ts` for the table
  // and `tests/turn-delivery-probe.mts` for the harness that produced it.
  const enter = String.fromCharCode(13);
  const turn = 'You are a governed agent.\n\nTASK: say BANANA\n  1. tdd@v1#abc\n';
  for (const provider of PROVIDER_KINDS) {
    const steps = adapters[provider].deliverTurn(turn);
    const wire = steps.map((step) => step.utf8Text).join('');
    assert.equal(wire.endsWith(enter), true, `${provider} never presses Enter`);
    assert.equal(wire.slice(0, -1), turn,
      `${provider} rewrote the turn on the way out instead of typing what it was given`);
  }
});

test('a carriage return inside a brief is a line break, never half a turn', async () => {
  // The one transformation that survives, and the reason it has to: a bare CR
  // in the text would submit whatever came before it and leave the rest in the
  // composer. In a brief a CR means a line break, so that is what it becomes.
  const enter = String.fromCharCode(13);
  const turn = `first${enter}second${enter}\nthird`;
  for (const provider of PROVIDER_KINDS) {
    const steps = adapters[provider].deliverTurn(turn);
    assert.equal(steps.length, 2, `${provider} split a turn containing a CR into extra writes`);
    assert.equal(steps[0]!.utf8Text.includes(enter), false,
      `${provider} would submit half of this brief`);
    for (const word of ['first', 'second', 'third']) {
      assert.equal(steps[0]!.utf8Text.includes(word), true, `${provider} dropped "${word}"`);
    }
  }
});

test('a confirmation is found through the furniture a real TUI paints around it', async () => {
  // Read off a real codex 0.146.0 during the rebuilt public proof: the reply is
  // decorated with a bullet, and the composer's placeholder is painted onto the
  // same row after it. `startsWith(marker)` found nothing, and a governed Run
  // died at the gate for two minutes of silence with the correct answer on the
  // screen the whole time.
  const marker = 'SKILLS-CONFIRMED:';
  const tokens = '["elite-codebase-engineering@v3#a1b2c3d4","test-driven-development@v2#e5f6a7b8"]';
  const screen = [
    'Working (0s • esc to interrupt)',
    `• ${marker} ${tokens}›Improve documentation in @filename  gpt-5.6-sol xhigh · ~/repo`,
  ].join('\n');
  for (const provider of PROVIDER_KINDS) {
    const found = adapters[provider].findConfirmationLine({ text: screen }, marker);
    assert.equal(found, `${marker} ${tokens}`,
      `${provider} could not read a confirmation a human can see`);
  }
});

test('a wrong answer is still judged, never left to time out', async () => {
  // The other half of the same function. Tolerating decoration must not turn a
  // refusal into silence: an agent that answers WRONG has to be recorded as
  // drift, and only an agent that says NOTHING may time out.
  const marker = 'SKILLS-CONFIRMED:';
  for (const provider of PROVIDER_KINDS) {
    const wrong = adapters[provider].findConfirmationLine(
      { text: `${marker} not json at all` }, marker,
    );
    assert.equal(wrong, `${marker} not json at all`, `${provider} swallowed a wrong answer`);
    const silent = adapters[provider].findConfirmationLine({ text: 'nothing here' }, marker);
    assert.equal(silent, null, `${provider} found a confirmation in an empty screen`);
  }
});

test('a confirmation still being painted is not a wrong one', async () => {
  // A streaming reply reaches the screen a piece at a time, so for a moment a
  // real kimi shows `SKILLS-CONFIRMED:` and nothing else. An empty body is not
  // JSON, so judging that moment terminated the Run for skills drift a few
  // hundred milliseconds before the agent's own answer arrived.
  const marker = 'SKILLS-CONFIRMED:';
  for (const provider of PROVIDER_KINDS) {
    for (const half of [`● ${marker}`, marker, `${marker} ["elite-codebase-engineering@v3#a1b2c3d4",`]) {
      assert.equal(adapters[provider].findConfirmationLine({ text: half }, marker), null,
        `${provider} judged a confirmation that was still arriving: ${half}`);
    }
  }
});

test('a confirmation that WRAPPED is still one confirmation', async () => {
  // A screen is not a transcript. The canonical reply for two pinned skills is
  // about 100 characters after the marker, so a real kimi wraps it and the row
  // the marker is on holds half an array. Judging that row alone reported "the
  // confirmation was not a JSON array" over a correct confirmation that was on
  // the screen, complete, one line lower.
  const marker = 'SKILLS-CONFIRMED:';
  const screen = [
    'thinking...',
    `${marker} ["elite-codebase-engineering@v3#a1b2c3d4",`,
    '"test-driven-development@v2#e5f6a7b8"]',
  ].join('\n');
  const whole = `${marker} ["elite-codebase-engineering@v3#a1b2c3d4","test-driven-development@v2#e5f6a7b8"]`;
  for (const provider of PROVIDER_KINDS) {
    assert.equal(adapters[provider].findConfirmationLine({ text: screen }, marker), whole,
      `${provider} judged half of a wrapped confirmation`);
  }
});

test('the gate\'s OWN sentence about the marker is never mistaken for an answer', async () => {
  // Turn 1 says "start it with SKILLS-CONFIRMED:" — marker at the end of the
  // line, nothing after it. A real kimi repaints that row often enough to land
  // it after the prompt's own fingerprint, where the gate's position anchor can
  // no longer exclude it, and the Run was terminated for its supervisor's words
  // while the agent was still composing its reply.
  const marker = 'SKILLS-CONFIRMED:';
  const echo = [
    '    Reply with EXACTLY ONE line and no other content: start it with SKILLS-CONFIRMED:',
    '    then one space, then a JSON array of the tokens above, quoted, in the order',
  ].join('\n');
  for (const provider of PROVIDER_KINDS) {
    assert.equal(adapters[provider].findConfirmationLine({ text: echo }, marker), null,
      `${provider} read the gate's own instruction back as a confirmation`);
  }
});

test('the Enter that submits a turn is its own write, after a beat', async () => {
  // Measured against all THREE real binaries on 2026-08-02, driving raw PTYs
  // with no Novakai machinery in the way (tests/turn-delivery-probe.mts):
  //
  //   the gate's real 532-char turn 1        claude    codex     kimi
  //   text and Enter in ONE write            NOT SENT  NOT SENT  NOT SENT
  //   text, beat, Enter alone                SENT      SENT      SENT
  //
  // A big burst is taken as a PASTE, and an Enter inside that burst is absorbed
  // into the pasted text instead of submitting it. The turn lands in the
  // composer, echoes, and sits there forever — which is hold-out B3, and why a
  // governed launch timed out at the gate against every real provider.
  //
  // The claim used to be Claude-only and generalised by assertion; it is now
  // three measurements. So delivery is not one string: the text goes first,
  // then a pause, then the key.
  const enter = String.fromCharCode(13);
  const turn = `a governed turn long enough to be taken for a paste: ${'token '.repeat(90)}`;
  for (const provider of PROVIDER_KINDS) {
    const steps = adapters[provider].deliverTurn(turn);
    assert.equal(steps.length >= 2, true,
      `${provider} delivers a turn in one write, so its Enter can be absorbed as paste`);
    const last = steps[steps.length - 1]!;
    assert.equal(last.utf8Text, enter, `${provider} does not end by pressing Enter alone`);
    for (const step of steps.slice(0, -1)) {
      assert.equal(step.utf8Text.includes(enter), false,
        `${provider} puts Enter inside the same write as the turn`);
    }
    // The beat is what separates the burst from the key. Without it the two
    // writes can still arrive as one chunk.
    assert.equal(steps[steps.length - 2]!.pauseMsAfter > 0, true,
      `${provider} presses Enter with no pause after the text`);
  }
});
