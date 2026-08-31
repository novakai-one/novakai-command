// The Claude Code adapter, interactive.
//
// Machine surface verified live against Claude Code 2.1.219 on 2026-08-01 via
// `claude --help`:
//
//     claude [--model <alias>] [--session-id <uuid>] [--add-dir <dir>...]
//     claude --resume <session-id> [--fork-session]
//     claude --continue
//
// The load-bearing flag is `--session-id <uuid>`: Claude Code lets Novakai
// PRE-ASSIGN the conversation id. That turns the session reservation from a
// hope into an identity — the Runtime mints `sess_<uuidv4>` before the Run
// record exists, this adapter hands the uuid straight to the CLI, and
// discovery echoes the exact id it was given rather than inferring one from a
// file or a PID.
//
// What this adapter does NOT claim: a mid-session model switch (`--model` is a
// launch flag, and no verified live mechanism exists), an effort control (no
// such flag exists at this version), or an observed compact.
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
import { claudeInputReadyOn } from './input-readiness.js';
import { mergedEnvironment, probeVersion, resolveCli, uuidOf } from './cli-probe.js';
import {
  observeProviderBoundaryFile, productionBoundaryProfile,
} from './turn-boundary.js';

/** Values that mean "pass no --model flag; let the CLI decide". */
const NO_MODEL_FLAG = new Set(['cli-default', 'claude-cli', '']);

const claims = (
  support: ProviderCapability['support'], evidence: string, limitations: string[] = [],
): ProviderCapability => ({ support, evidence, limitations });

export interface ClaudeAdapterOptions {
  readonly cliPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sessionRoot?: string;
}

/**
 * The host's own session, told to the launched CLI by accident.
 *
 * Claude Code sets this in every process it spawns so that a NESTED invocation
 * does not persist a second transcript. The Runtime inherits it when it is
 * started from inside a Claude Code session, and `mergedEnvironment` then
 * copies it into every managed PTY — at which point the provider writes no
 * transcript file at all, and transcript custody would be reading a file the
 * provider deliberately declined to create. The provider's own terminal said
 * so: "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
 *
 * A Novakai-managed Run is not a child of whoever started the Runtime: it has
 * its own reserved session id, its own custody record and its own Thread. So
 * the marker is dropped rather than forwarded. Nothing else in the environment
 * is touched — a spawned Agent still authenticates as itself.
 */
const INHERITED_HOST_SESSION_MARKER = 'CLAUDE_CODE_CHILD_SESSION';

function launchEnvironment(
  base: NodeJS.ProcessEnv, runtime: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = mergedEnvironment(base, runtime);
  delete merged[INHERITED_HOST_SESSION_MARKER];
  return merged;
}

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): InteractiveProviderAdapter {
  const executable = options.cliPath ?? resolveCli('claude');
  const sessionRoot = options.sessionRoot ?? path.join(homedir(), '.claude', 'projects');
  let version: string | null = null;
  const versionOf = (): string => {
    version ??= probeVersion(executable);
    return version;
  };

  return {
    provider: 'claude',

    async discoverCapabilities(): Promise<ProviderCapabilityReport> {
      const tested = versionOf();
      const installed = executable !== '';
      const absent = claims('unavailable', 'the claude CLI is not on PATH');
      if (!installed) {
        return everyCapability('claude', tested, absent);
      }
      const profile = productionBoundaryProfile('claude', tested);
      const boundary = profile === null
        ? claims('unavailable', `claude ${tested} has no conformance-tested boundary profile`)
        : claims('native', `exact-version boundary profile ${profile.id}; source-schema ${profile.sourceFormatSchemaDigest}; terminal-semantics ${profile.completionFrame.terminalSemanticsEvidenceDigest}`);
      return {
        provider: 'claude',
        testedProviderVersion: tested,
        resume: claims('native', '`-r, --resume [value]` in `claude --help`'),
        fresh: claims('native', 'a plain `claude` invocation starts a new session'),
        compact: claims('advisory',
          'resume, then send `/compact`; the provider performs the compaction and '
          + 'Novakai cannot observe that it happened',
          ['compaction is not verifiable from outside the session']),
        modelChange: claims('replacement-required',
          '`--model <model>` is a launch flag; no verified mid-session switch '
          + 'exists at this version'),
        effortChange: claims('unsupported', 'no effort flag exists in `claude --help`'),
        interrupt: claims('advisory',
          'Escape is the documented in-session interrupt key; Novakai sends it and '
          + 'cannot confirm from outside that the turn ended',
          ['the provider does not acknowledge an interrupt on any machine channel']),
        safeMessageBoundary: claims('native',
          'the interactive prompt submits on carriage return'),
        transcriptDiscovery: claims('unavailable',
          'the session file is ~/.claude/projects/'
          + '<sanitised-cwd>/<sessionId>.jsonl'),
        usage: claims('unavailable', 'no per-Run usage channel at this version'),
        screenContext: claims('unsupported', 'no screen-context channel at this version'),
        nativeSubagentObservation: claims('unavailable',
          'no native subagent observation channel at this version'),
        turnBoundary: boundary,
        turnBoundaryProfile: profile,
      };
    },

    async observeProviderTurnBoundary(input) {
      const profile = productionBoundaryProfile('claude', versionOf());
      if (profile === null) {
        return b3ok({
          kind: 'uncertain' as const,
          reason: 'provider-version-unsupported' as const,
          evidenceRefs: [`claude ${versionOf()}`],
        });
      }
      return b3ok(observeProviderBoundaryFile(
        profile, sessionRoot, input,
      ));
    },

    async buildLaunch(
      plan: ResolvedLaunchPlan, input: ProviderLaunchInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled());
      // The reservation becomes the CLI's own conversation id, so
      // "the adapter must echo the exact expected id" is true by construction.
      const argv = ['--session-id', uuidOf(input.reservedProviderSessionId)];
      if (!NO_MODEL_FLAG.has(plan.modelId)) argv.push('--model', plan.modelId);
      return b3ok({
        executable,
        argv,
        environment: launchEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: fingerprintOf(plan, input.workingDirectory),
      });
    },

    async discoverSession(
      input: ProviderSessionDiscoveryInput,
    ): Promise<B3Result<ProviderSessionEvidence>> {
      // The id was ASSIGNED at launch, so discovery is a statement of fact
      // rather than a search. The exact echo is required; here it is exact by
      // construction, and no substitution is possible.
      return b3ok({
        providerSessionId: input.expectedProviderSessionId,
        providerNativeSessionId: uuidOf(input.expectedProviderSessionId),
        live: 'live',
        evidence: [
          `launched with --session-id ${uuidOf(input.expectedProviderSessionId)}`,
          `claude ${versionOf()}`,
        ],
      });
    },

    async buildContinuation(
      input: ProviderContinuationInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      if (executable === '') return b3fail(notInstalled());
      const argv: string[] = [];
      if (input.mode === 'resume' || input.mode === 'compact') {
        if (input.oldSession.providerNativeSessionId === '') {
          return b3fail(b3err('UnsupportedOperation',
            'claude cannot resume a session whose native id was never established',
            { operation: 'agent.continue', provider: 'claude', reason: 'no-native-session-id' },
            false));
        }
        argv.push('--resume', input.oldSession.providerNativeSessionId);
      }
      if (!NO_MODEL_FLAG.has(input.launchPlan.modelId)) {
        argv.push('--model', input.launchPlan.modelId);
      }
      return b3ok({
        executable,
        argv,
        environment: launchEnvironment(options.environment ?? process.env, input.runtimeEnvironment),
        workingDirectory: input.workingDirectory,
        launchFingerprint: `claude:${input.mode}:${input.workingDirectory}`,
        ...(argv.includes('--resume')
          ? { privateResumeHandle: input.oldSession.providerNativeSessionId } : {}),
      });
    },

    async requestInterrupt(
      _input: ProviderInterruptInput,
    ): Promise<B3Result<ProviderInterruptOutcome>> {
      // Terminal owns the keystroke; this adapter owns the claim about it. The
      // claim is `advisory`, so the outcome says "requested", never "done".
      return b3ok({ kind: 'interrupt-requested' });
    },

    async applyControl(
      input: ProviderControlInput,
    ): Promise<B3Result<ProviderControlOutcome>> {
      if (input.control.name === 'model') {
        return b3ok({
          kind: 'replacement-required',
          reason: '`--model` applies at launch; changing it needs a new Run',
        });
      }
      return b3ok({
        kind: 'unsupported',
        reason: `claude ${versionOf()} exposes no ${input.control.name} control`,
      });
    },

    // The turn as written, then the key that sends it — see turn-delivery.ts
    // for what was measured against this binary.
    deliverTurn,

    findConfirmationLine(observation: ProviderReplyObservation, marker: string) {
      return findMarkerLine(observation.text, marker);
    },

    // The composer box exists — see input-readiness.ts for the boot capture.
    inputReadyOn: claudeInputReadyOn,
  };
}

export function fingerprintOf(plan: ResolvedLaunchPlan, workingDirectory: string): string {
  return `claude:${plan.modelId}:${plan.effort}:${workingDirectory}`;
}

export function notInstalled(): ReturnType<typeof b3err> {
  return b3err('UnsupportedOperation', 'the claude CLI is not installed on this machine',
    { operation: 'agent.spawn', provider: 'claude', reason: 'cli-not-found' }, false);
}

/** Every answer is the same when the CLI is absent: we cannot know. */
export function everyCapability(
  provider: ProviderCapabilityReport['provider'],
  testedProviderVersion: string,
  answer: ProviderCapability,
): ProviderCapabilityReport {
  return {
    provider,
    testedProviderVersion,
    resume: answer,
    fresh: answer,
    compact: answer,
    modelChange: answer,
    effortChange: answer,
    interrupt: answer,
    safeMessageBoundary: answer,
    transcriptDiscovery: answer,
    usage: answer,
    screenContext: answer,
    nativeSubagentObservation: answer,
    turnBoundary: answer,
    turnBoundaryProfile: null,
  };
}
