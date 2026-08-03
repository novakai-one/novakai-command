import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  deterministicId, mintProviderSessionId, mintProviderTurnId,
  type ProviderTurnBoundaryProfileId, type TranscriptBindingId,
} from '@novakai/foundation/contract';
import {
  boundaryProfile, boundaryProfileValid, observeProviderBoundarySource,
  productionBoundaryProfile,
  type ProviderKind, type ProviderTurnBoundaryInput,
} from '../contract/index.js';

const text = 'perform one exact semantic turn';
const inputDigest = createHash('sha256').update(text, 'utf8').digest('hex');
const versions: Record<ProviderKind, string> = {
  claude: '2.1.219 (Claude Code)',
  codex: 'codex-cli 0.146.0',
  kimi: '0.31.1',
};

const input = (): ProviderTurnBoundaryInput => ({
  providerSessionId: mintProviderSessionId(),
  providerNativeSessionId: 'native-session-fixture',
  transcriptBindingId: deterministicId(
    'transcriptBinding', ['provider-turn-boundary-fixture'],
  ) as TranscriptBindingId,
  providerTurnId: mintProviderTurnId(),
  inputDigest,
  startTranscriptWatermark: null,
  currentTranscriptWatermark: '0000000009',
});

const jsonl = (...rows: readonly unknown[]): string =>
  rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');

const claude = () => jsonl(
  {
    type: 'user', uuid: 'claude-input', parentUuid: null,
    sessionId: 'native-session-fixture', timestamp: '2026-08-03T01:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  },
  {
    type: 'assistant', uuid: 'claude-tool', parentUuid: 'claude-input',
    sessionId: 'native-session-fixture', timestamp: '2026-08-03T01:00:01.000Z',
    message: {
      role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1' }],
    },
  },
  {
    type: 'user', uuid: 'claude-result', parentUuid: 'claude-tool',
    sessionId: 'native-session-fixture', timestamp: '2026-08-03T01:00:02.000Z',
    message: {
      role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
    },
  },
  {
    type: 'assistant', uuid: 'claude-final', parentUuid: 'claude-result',
    sessionId: 'native-session-fixture', timestamp: '2026-08-03T01:00:03.000Z',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  },
);

const codex = () => jsonl(
  {
    type: 'event_msg', timestamp: '2026-08-03T02:00:00.000Z',
    payload: { type: 'task_started', turn_id: 'codex-turn-1' },
  },
  {
    type: 'response_item', timestamp: '2026-08-03T02:00:01.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  },
  {
    type: 'response_item', timestamp: '2026-08-03T02:00:02.000Z',
    payload: { type: 'function_call', call_id: 'call-1' },
  },
  {
    type: 'response_item', timestamp: '2026-08-03T02:00:03.000Z',
    payload: { type: 'function_call_output', call_id: 'call-1' },
  },
  {
    type: 'response_item', timestamp: '2026-08-03T02:00:04.000Z',
    payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] },
  },
  {
    type: 'event_msg', timestamp: '2026-08-03T02:00:05.000Z',
    payload: { type: 'task_complete', turn_id: 'codex-turn-1' },
  },
);

const kimi = () => jsonl(
  { type: 'turn.prompt', time: 1785700000000, input: [{ type: 'text', text }] },
  {
    type: 'context.append_loop_event', time: 1785700001000,
    event: { type: 'step.begin', turnId: 'kimi-turn-1', step: 1, uuid: 'step-1' },
  },
  {
    type: 'context.append_loop_event', time: 1785700002000,
    event: { type: 'content.part', turnId: 'kimi-turn-1', step: 1, uuid: 'part-1' },
  },
  {
    type: 'context.append_loop_event', time: 1785700003000,
    event: {
      type: 'step.end', turnId: 'kimi-turn-1', step: 1,
      uuid: 'step-1', finishReason: 'end_turn',
    },
  },
);

const fixtures: Record<ProviderKind, () => string> = { claude, codex, kimi };

test('all supported provider versions publish digest-valid exact framing profiles', () => {
  for (const provider of ['claude', 'codex', 'kimi'] as const) {
    const profile = boundaryProfile(provider, versions[provider]);
    assert.equal(boundaryProfileValid(profile), true, `${provider} profile digest is invalid`);
    assert.equal(profile.executableVersion, versions[provider]);
    assert.equal(profile.correlation.mode, 'explicit-response-envelope');
    const forged = { ...profile, id: 'turnBoundaryProfile_forged' as ProviderTurnBoundaryProfileId };
    assert.equal(boundaryProfileValid(forged), false, `${provider} accepted a forged profile id`);
    if (profile.correlation.mode === 'explicit-response-envelope') {
      const samePhase = {
        ...profile,
        correlation: {
          ...profile.correlation,
          completionTerminalPhaseValue: profile.correlation.inputStartPhaseValue,
        },
      };
      assert.equal(boundaryProfileValid(samePhase), false,
        `${provider} accepted indistinguishable input/completion phases`);
    }
  }
  assert.equal(productionBoundaryProfile('codex', 'codex-cli 0.146.1'), null);
});

test('all three exact source schemas prove only their native terminal frame', () => {
  for (const provider of ['claude', 'codex', 'kimi'] as const) {
    const observation = observeProviderBoundarySource(
      boundaryProfile(provider, versions[provider]), input(), fixtures[provider](),
    );
    assert.equal(observation.kind, 'proven', `${provider} did not prove its positive fixture`);
    if (observation.kind === 'proven') {
      assert.equal(observation.submittedInputEvidenceDigest, inputDigest);
      assert.notEqual(observation.submittedInputSourcePosition,
        observation.completionSourcePosition);
      assert.notEqual(observation.providerCorrelationId, '');
    }
  }
});

test('echo, assistant/tool intermediates, truncation, gaps, and marker-shaped content never complete', () => {
  const mutations: Readonly<Record<string, (provider: ProviderKind, source: string) => string>> = {
    'echo-only': (_provider, source) => source.split('\n')[0]!,
    truncated: (_provider, source) => source.split('\n').slice(0, -1).join('\n'),
    'source-gap': (_provider, source) => `${source.split('\n')[0]}\n{not-json}\n${source}`,
    'duplicate-input': (provider, source) => {
      const lines = source.split('\n');
      return `${lines[provider === 'codex' ? 1 : 0]}\n${source}`;
    },
    'content-marker': (provider, source) => jsonl(
      JSON.parse(source.split('\n')[0]!) as object,
      provider === 'claude'
        ? {
            type: 'assistant', uuid: 'marker-only', parentUuid: 'claude-input',
            sessionId: 'native-session-fixture', timestamp: '2026-08-03T03:00:00.000Z',
            message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'task_complete end_turn' }] },
          }
        : provider === 'codex'
          ? {
              type: 'response_item', timestamp: '2026-08-03T03:00:00.000Z',
              payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'task_complete' }] },
            }
          : {
              type: 'context.append_loop_event', time: 1785700001000,
              event: { type: 'content.part', turnId: 'kimi-turn-1', text: 'step.end end_turn' },
            },
    ),
  };
  for (const provider of ['claude', 'codex', 'kimi'] as const) {
    const profile = boundaryProfile(provider, versions[provider]);
    for (const [name, mutate] of Object.entries(mutations)) {
      const observed = observeProviderBoundarySource(profile, input(), mutate(provider, fixtures[provider]()));
      assert.notEqual(observed.kind, 'proven', `${provider} proved the ${name} mutant`);
    }
  }
});

test('wrong session, old watermark, and unsupported profile changes never complete', () => {
  for (const provider of ['claude', 'codex', 'kimi'] as const) {
    const exact = input();
    const wrongSession = observeProviderBoundarySource(
      boundaryProfile(provider, versions[provider]),
      { ...exact, providerNativeSessionId: 'another-native-session' },
      fixtures[provider](),
    );
    if (provider === 'claude') assert.notEqual(wrongSession.kind, 'proven');
    const oldWatermark = observeProviderBoundarySource(
      boundaryProfile(provider, versions[provider]),
      { ...exact, startTranscriptWatermark: '0000000008' },
      fixtures[provider](),
    );
    assert.notEqual(oldWatermark.kind, 'proven');
    const profile = boundaryProfile(provider, versions[provider]);
    const unsupported = observeProviderBoundarySource(
      { ...profile, executableVersion: 'newer-untested-version' }, exact, fixtures[provider](),
    );
    assert.equal(unsupported.kind, 'uncertain');
  }
});
