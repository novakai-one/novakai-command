// The Kimi Code adapter, interactive (B3V4-P2 §14).
//
// Machine surface verified live against kimi 0.30.0 on 2026-08-01 via
// `kimi --help`:
//
//     kimi [-m <model>] [--skills-dir <dir>] [--add-dir <dir>] [--auto]
//     kimi -S <session-id>
//     kimi -c
//
// Like Codex and unlike Claude Code, kimi will not accept a pre-assigned
// conversation id, so the native id is discovered from the session directory it
// creates under ~/.kimi-code/sessions/wd_<workspace>/session_<uuid>/. The same
// honesty rule applies: no directory in the window means `live: 'unknown'` and
// an empty native id, never the newest directory on the machine.
//
// `--skills-dir` is the one place a pinned skill list reaches a provider
// natively. It is passed when the plan's skills resolve to directories; the
// two-turn gate still runs, because a directory being on the command line is
// not the same fact as the Agent having read what is in it.
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
  kimiSessionIdFrom, mergedEnvironment, newestSessionSince, probeVersion, resolveCli,
} from './cli-probe.js';

/** Legacy seed values that are NOT model names and must never reach the CLI. */
const NO_MODEL_FLAG = new Set(['cli-default', 'kimi-cli', '']);

const claims = (
  support: ProviderCapability['support'], evidence: string, limitations: string[] = [],
): ProviderCapability => ({ support, evidence, limitations });

export interface KimiAdapterOptions {
  readonly cliPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sessionRoot?: string;
  readonly discoveryWindowMs?: number;
  /** Absolute directories holding the skills a plan pins, if any resolve. */
  readonly skillsDirectories?: readonly string[];
}

const DEFAULT_DISCOVERY_WINDOW_MS = 4_000;

export function createKimiAdapter(
  options: KimiAdapterOptions = {},
): InteractiveProviderAdapter {
  const executable = options.cliPath
    ?? resolveCli('kimi', path.join(homedir(), '.kimi-code', 'bin', 'kimi'));
  const sessionRoot = options.sessionRoot ?? path.join(homedir(), '.kimi-code', 'sessions');
  const launchedAt = new Map<string, number>();
  let version: string | null = null;
  const versionOf = (): string => {
    version ??= probeVersion(executable);
    return version;
  };

  const skillFlags = (): string[] =>
    (options.skillsDirectories ?? []).flatMap((directory) => ['--skills-dir', directory]);

  return {
    provider: 'kimi',

    async discoverCapabilities(): Promise<ProviderCapabilityReport> {
      const tested = versionOf();
      if (executable === '') {
        return everyCapability('kimi', tested, claims('unavailable', 'the kimi CLI is not on PATH'));
      }
      return {
        provider: 'kimi',
        testedProviderVersion: tested,
        resume: claims('native',
          '`-S, --session [id]` in `kimi --help`',
          ['requires a native session id discovered from the session directory']),
        fresh: claims('native', 'a plain `kimi` invocation starts a new session'),
        compact: claims('unavailable',
          'no compact flag or verified in-session command was probed at this version'),
        modelChange: claims('replacement-required',
          '`-m, --model <model>` is per-invocation; B1 OD-C3 verified the sticky '
          + 'mechanism only for the non-interactive `-p` lane'),
        effortChange: claims('unsupported', 'no effort flag exists in `kimi --help`'),
        interrupt: claims('advisory',
          'Novakai sends the terminal interrupt; kimi does not acknowledge it on '
          + 'any machine channel',
          ['the outcome of an interrupt cannot be confirmed from outside']),
        safeMessageBoundary: claims('native',
          'the interactive prompt submits on carriage return'),
        transcriptDiscovery: claims('unavailable',
          `transcript binding is B3c; sessions live under ${sessionRoot}`),
        usage: claims('unavailable',
          'kimi stream-json emitted no usage line at 0.29.1 (B1 DEC-B1-7); per-Run '
          + 'usage is B3d'),
        screenContext: claims('unsupported', 'no screen-context channel at this version'),
        nativeSubagentObservation: claims('unavailable', 'native subagent observation is B3c'),
      };
    },

    async buildLaunch(
      plan: ResolvedLaunchPlan, input: ProviderLaunchInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled('agent.spawn'));
      launchedAt.set(input.reservedProviderSessionId, Date.now() - 1_000);
      const argv = [...skillFlags()];
      if (!NO_MODEL_FLAG.has(plan.modelId)) argv.push('--model', plan.modelId);
      return b3ok({
        executable,
        argv,
        environment: mergedEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: `kimi:${plan.modelId}:${plan.effort}:${input.workingDirectory}`,
      });
    },

    async discoverSession(
      input: ProviderSessionDiscoveryInput,
    ): Promise<B3Result<ProviderSessionEvidence>> {
      const since = launchedAt.get(input.expectedProviderSessionId) ?? 0;
      const found = await waitForSessionDirectory(
        sessionRoot, since, options.discoveryWindowMs ?? DEFAULT_DISCOVERY_WINDOW_MS,
      );
      if (found === null) {
        return b3ok({
          providerSessionId: input.expectedProviderSessionId,
          providerNativeSessionId: '',
          live: 'unknown',
          evidence: [`no kimi session directory appeared under ${sessionRoot} after launch`],
        });
      }
      return b3ok({
        providerSessionId: input.expectedProviderSessionId,
        providerNativeSessionId: found.nativeSessionId,
        live: 'live',
        evidence: [`kimi session ${found.sourceLocator}`, `kimi ${versionOf()}`],
      });
    },

    async buildContinuation(
      input: ProviderContinuationInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled('agent.continue'));
      if (input.mode === 'compact') {
        return b3fail(b3err('UnsupportedOperation',
          `kimi ${versionOf()} exposes no compact mechanism this adapter has verified`,
          { operation: 'agent.continue', provider: 'kimi', reason: 'compact-unavailable' },
          false));
      }
      const argv = [...skillFlags()];
      if (input.mode === 'resume') {
        if (input.oldSession.providerNativeSessionId === '') {
          return b3fail(b3err('UnsupportedOperation',
            'kimi cannot resume a session whose native id was never discovered',
            { operation: 'agent.continue', provider: 'kimi', reason: 'no-native-session-id' },
            false));
        }
        argv.push('--session', input.oldSession.providerNativeSessionId);
      }
      if (!NO_MODEL_FLAG.has(input.launchPlan.modelId)) {
        argv.push('--model', input.launchPlan.modelId);
      }
      return b3ok({
        executable,
        argv,
        environment: mergedEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: `kimi:${input.mode}:${input.workingDirectory}`,
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
      if (input.control.name === 'model') {
        return b3ok({
          kind: 'replacement-required',
          reason: 'kimi applies --model per invocation; changing it needs a new Run',
        });
      }
      return b3ok({
        kind: 'unsupported',
        reason: `kimi ${versionOf()} exposes no ${input.control.name} control`,
      });
    },

    deliverTurn,

    findConfirmationLine(observation: ProviderReplyObservation, marker: string) {
      return findMarkerLine(observation.text, marker);
    },
  };
}

async function waitForSessionDirectory(
  root: string, since: number, windowMs: number,
): Promise<ReturnType<typeof newestSessionSince>> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const found = newestSessionSince(root, since, kimiSessionIdFrom);
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((settle) => { setTimeout(settle, 200); });
  }
}

function notInstalled(operation: string): ReturnType<typeof b3err> {
  return b3err('UnsupportedOperation', 'the kimi CLI is not installed on this machine',
    { operation, provider: 'kimi', reason: 'cli-not-found' }, false);
}
