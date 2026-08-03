// The Codex adapter, interactive (B3V4-P2 §14).
//
// Machine surface verified live against codex-cli 0.144.5 on 2026-08-01 via
// `codex --help` and `codex resume --help`:
//
//     codex [-m <MODEL>] [-c <key=value>] [-C <DIR>] [PROMPT]
//     codex resume <SESSION_ID> [PROMPT]
//     codex resume --last
//
// Unlike Claude Code, Codex will NOT let Novakai pre-assign the conversation
// id. So the reservation stays a Novakai id and the provider-native id is
// DISCOVERED from the rollout file Codex writes under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl.
//
// That discovery is evidence, not proof, and this adapter says so: if no
// rollout appears in the window after launch, it reports `live: 'unknown'` with
// an empty native id rather than picking the newest file and hoping. A Run with
// no native id simply cannot be resumed, and `buildContinuation` refuses it by
// name instead of resuming somebody else's session.
import { homedir } from 'node:os';
import path from 'node:path';
import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type {
  InteractiveProviderAdapter, PrivateProviderLaunch, ProviderCapability,
  ProviderCapabilityReport, ProviderContinuationInput, ProviderControlInput,
  ProviderControlOutcome, ProviderInterruptInput, ProviderInterruptOutcome,
  ProviderLaunchInput, ProviderReplyObservation, ProviderSessionDiscoveryInput,
  ProviderSessionEvidence,
} from '../../contract/providers.js';
import type { ResolvedLaunchPlan } from '../../contract/records.js';
import { deliverTurn, findMarkerLine } from './turn-delivery.js';
import { everyCapability } from './claude.js';
import {
  codexSessionIdFrom, mergedEnvironment, newestSessionSince, probeVersion, resolveCli,
} from './cli-probe.js';
import { boundaryProfile, unavailableBoundary } from './turn-boundary.js';

const NO_MODEL_FLAG = new Set(['cli-default', 'codex-cli', '']);

/**
 * The efforts that mean "pass no effort override; let the CLI decide".
 *
 * `default` is Novakai's own sentinel for an unpinned control, and it is NOT a
 * codex effort. Sending it produced an HTTP 400 from the model endpoint —
 * `[reasoning.effort] [invalid_enum_value] Invalid value: 'default'. Supported
 * values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'` —
 * after the session had launched and been asked its gate question, so the Run
 * died at the gate with no confirmation and nothing anywhere said why. Found by
 * the rebuilt public proof (NVK-KIMI-032), driving a real codex.
 */
const NO_EFFORT_FLAG = new Set(['default', 'cli-default', '']);

const claims = (
  support: ProviderCapability['support'], evidence: string, limitations: string[] = [],
): ProviderCapability => ({ support, evidence, limitations });

export interface CodexAdapterOptions {
  readonly cliPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Where rollouts land. Overridable so a test never reads the real home. */
  readonly sessionRoot?: string;
  /** How long discovery waits for a rollout to appear. */
  readonly discoveryWindowMs?: number;
}

const DEFAULT_DISCOVERY_WINDOW_MS = 4_000;

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): InteractiveProviderAdapter {
  const executable = options.cliPath ?? resolveCli('codex');
  const sessionRoot = options.sessionRoot ?? path.join(homedir(), '.codex', 'sessions');
  /** Launch time per reservation, so discovery only ever looks forward. */
  const launchedAt = new Map<string, number>();
  let version: string | null = null;
  const versionOf = (): string => {
    version ??= probeVersion(executable);
    return version;
  };

  return {
    provider: 'codex',

    async discoverCapabilities(): Promise<ProviderCapabilityReport> {
      const tested = versionOf();
      if (executable === '') {
        return everyCapability('codex', tested, claims('unavailable', 'the codex CLI is not on PATH'));
      }
      const profile = boundaryProfile('codex', tested);
      return {
        provider: 'codex',
        testedProviderVersion: tested,
        resume: claims('native',
          '`codex resume <SESSION_ID>` in `codex resume --help`',
          ['requires a native session id discovered from the rollout file']),
        fresh: claims('native', 'a plain `codex` invocation starts a new session'),
        compact: claims('unavailable',
          'no compact flag or verified in-session command was probed at this version'),
        modelChange: claims('replacement-required',
          '`-m, --model <MODEL>` is a launch flag; B1 OD-C3 found no verified '
          + 'mid-session switch'),
        effortChange: claims('replacement-required',
          '`-c <key=value>` applies config overrides at launch only'),
        interrupt: claims('advisory',
          'Novakai sends the terminal interrupt; codex does not acknowledge it on '
          + 'any machine channel',
          ['the outcome of an interrupt cannot be confirmed from outside']),
        safeMessageBoundary: claims('native',
          'the interactive prompt submits on carriage return'),
        transcriptDiscovery: claims('unavailable',
          `transcript binding is B3c; rollouts live under ${sessionRoot}`),
        usage: claims('unavailable', 'per-Run usage is B3d'),
        screenContext: claims('unsupported', 'no screen-context channel at this version'),
        nativeSubagentObservation: claims('unavailable', 'native subagent observation is B3c'),
        turnBoundary: claims('native', `exact-version boundary profile ${profile.id}`),
        turnBoundaryProfile: profile,
      };
    },

    async observeProviderTurnBoundary() { return b3ok(unavailableBoundary()); },

    async buildLaunch(
      plan: ResolvedLaunchPlan, input: ProviderLaunchInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled('agent.spawn'));
      // Recorded BEFORE the process exists, so a rollout written a millisecond
      // after launch is still inside the window.
      launchedAt.set(input.reservedProviderSessionId, Date.now() - 1_000);
      const argv: string[] = [];
      if (!NO_MODEL_FLAG.has(plan.modelId)) argv.push('--model', plan.modelId);
      if (!NO_EFFORT_FLAG.has(plan.effort)) {
        argv.push('-c', `model_reasoning_effort=${JSON.stringify(plan.effort)}`);
      }
      return b3ok({
        executable,
        argv,
        environment: mergedEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: `codex:${plan.modelId}:${plan.effort}:${input.workingDirectory}`,
      });
    },

    async discoverSession(
      input: ProviderSessionDiscoveryInput,
    ): Promise<B3Result<ProviderSessionEvidence>> {
      const since = launchedAt.get(input.expectedProviderSessionId) ?? 0;
      const found = await waitForRollout(
        sessionRoot, since, options.discoveryWindowMs ?? DEFAULT_DISCOVERY_WINDOW_MS,
      );
      if (found === null) {
        // Honest absence. §13.5 forbids inferring a session from a PID, and
        // "the newest file in the directory" is the same mistake with a nicer
        // name — another codex on this machine would win the race.
        return b3ok({
          providerSessionId: input.expectedProviderSessionId,
          providerNativeSessionId: '',
          live: 'unknown',
          evidence: [`no codex rollout appeared under ${sessionRoot} after launch`],
        });
      }
      return b3ok({
        providerSessionId: input.expectedProviderSessionId,
        providerNativeSessionId: found.nativeSessionId,
        live: 'live',
        evidence: [`codex rollout ${found.sourceLocator}`, `codex ${versionOf()}`],
      });
    },

    async buildContinuation(
      input: ProviderContinuationInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled('agent.continue'));
      const argv: string[] = [];
      if (input.mode === 'resume') {
        if (input.oldSession.providerNativeSessionId === '') {
          return b3fail(b3err('UnsupportedOperation',
            'codex cannot resume a session whose native id was never discovered',
            { operation: 'agent.continue', provider: 'codex', reason: 'no-native-session-id' },
            false));
        }
        argv.push('resume', input.oldSession.providerNativeSessionId);
      }
      if (input.mode === 'compact') {
        return b3fail(b3err('UnsupportedOperation',
          `codex ${versionOf()} exposes no compact mechanism this adapter has verified`,
          { operation: 'agent.continue', provider: 'codex', reason: 'compact-unavailable' },
          false));
      }
      if (!NO_MODEL_FLAG.has(input.launchPlan.modelId)) {
        argv.push('--model', input.launchPlan.modelId);
      }
      return b3ok({
        executable,
        argv,
        environment: mergedEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: `codex:${input.mode}:${input.workingDirectory}`,
        ...(input.mode === 'resume'
          ? { privateResumeHandle: input.oldSession.providerNativeSessionId } : {}),
      });
    },

    async requestInterrupt(
      _input: ProviderInterruptInput,
    ): Promise<B3Result<ProviderInterruptOutcome>> {
      return b3ok({ kind: 'interrupt-requested' });
    },

    async applyControl(
      input: ProviderControlInput,
    ): Promise<B3Result<ProviderControlOutcome>> {
      if (input.control.name === 'model' || input.control.name === 'effort') {
        return b3ok({
          kind: 'replacement-required',
          reason: `codex applies ${input.control.name} at launch; changing it needs a new Run`,
        });
      }
      return b3ok({
        kind: 'unsupported',
        reason: `codex ${versionOf()} exposes no ${input.control.name} control`,
      });
    },

    deliverTurn,

    findConfirmationLine(observation: ProviderReplyObservation, marker: string) {
      return findMarkerLine(observation.text, marker);
    },
  };
}

/** Poll briefly; a rollout is written as the session starts, not seconds later. */
async function waitForRollout(
  root: string, since: number, windowMs: number,
): Promise<ReturnType<typeof newestSessionSince>> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const found = newestSessionSince(root, since, codexSessionIdFrom);
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((settle) => { setTimeout(settle, 200); });
  }
}

function notInstalled(operation: string): ReturnType<typeof b3err> {
  return b3err('UnsupportedOperation', 'the codex CLI is not installed on this machine',
    { operation, provider: 'codex', reason: 'cli-not-found' }, false);
}
