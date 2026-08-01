// A deterministic stand-in for the three real provider CLIs.
//
// This is a real seam variation, not ceremony: the contract suites need a
// provider whose capability answers, launch bytes and reply text are decided by
// the test rather than by whatever version of a CLI happens to be installed.
// The three production adapters implement exactly the same interface.
import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import { PROVIDER_KINDS, type ProviderKind } from '../../contract/records.js';
import type {
  InteractiveProviderAdapter, PrivateProviderLaunch, ProviderAdapterRegistry,
  ProviderCapability, ProviderCapabilityReport, ProviderContinuationInput,
  ProviderControlInput, ProviderControlOutcome, ProviderInterruptInput,
  ProviderInterruptOutcome, ProviderLaunchInput, ProviderReplyObservation,
  ProviderSessionDiscoveryInput, ProviderSessionEvidence,
} from '../../contract/providers.js';
import type { ResolvedLaunchPlan } from '../../contract/records.js';

const capability = (support: ProviderCapability['support'], evidence: string): ProviderCapability =>
  ({ support, evidence, limitations: [] });

export interface FakeProviderOptions {
  /** Override any capability answer, so a test can be about one of them. */
  readonly capabilities?: Partial<ProviderCapabilityReport>;
  /** What `discoverSession` reports; defaults to echoing the expected id. */
  readonly substituteSessionId?: string;
  readonly discoveryFails?: string;
  /**
   * Behave like a provider that READ its pinned skills and confirmed them, so a
   * governed launch can be proven end to end without spending real tokens.
   *
   * The tokens come from the LAUNCH PLAN this adapter is building — the same
   * place a real model's skill files come from — and never from the prompt.
   * A fake that parsed the prompt could not tell a working gate from one that
   * accepts its own words back, which is the defect that hid for a whole slice
   * (NVK-KIMI-028 finding 4).
   *
   * It also prints the Run credential the Runtime handed it, because that is
   * what a real agent does with it: uses it. An outside harness reads it off
   * the terminal and can then act AS that Run, which is how a second host
   * proves three generations without touching Runtime internals.
   */
  readonly confirmSkillsFromPlan?: boolean;
}

/** `id@v<version>#<digest>`, sorted — §6.3's exact set, canonical order. */
function planTokens(plan: ResolvedLaunchPlan): readonly string[] {
  return plan.skills
    .map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Wait for a line to arrive (turn 1), then say what this plan pinned, then
 * behave like any other session. The reply is composed from the PLAN; the
 * arriving line is only the cue that someone asked.
 */
function scriptedSession(provider: ProviderKind, plan: ResolvedLaunchPlan): string {
  const tokens = JSON.stringify(planTokens(plan)).replace(/'/gu, "'\\''");
  return `printf '%s ready\n' ${provider}; `
    + 'printf "NVK-RUN-CREDENTIAL: $NVK_AGENT_RUN_ID $NVK_AGENT_RUN_TOKEN\n"; '
    + 'IFS= read -r _asked; '
    + `printf 'SKILLS-CONFIRMED: %s\n' '${tokens}'; cat`;
}

export function createFakeProviderAdapter(
  provider: ProviderKind, options: FakeProviderOptions = {},
): InteractiveProviderAdapter {
  const report: ProviderCapabilityReport = {
    provider,
    testedProviderVersion: `${provider}-fake-1.0.0`,
    resume: capability('native', 'fake adapter'),
    fresh: capability('native', 'fake adapter'),
    compact: capability('native', 'fake adapter'),
    modelChange: capability('native', 'fake adapter'),
    effortChange: capability('native', 'fake adapter'),
    interrupt: capability('native', 'fake adapter'),
    safeMessageBoundary: capability('native', 'fake adapter'),
    transcriptDiscovery: capability('unavailable', 'transcript binding arrives in B3c'),
    usage: capability('unavailable', 'usage arrives in B3d'),
    screenContext: capability('unsupported', 'fake adapter'),
    nativeSubagentObservation: capability('unavailable', 'fake adapter'),
    ...options.capabilities,
  };

  return {
    provider,

    async discoverCapabilities() { return report; },

    async buildLaunch(
      plan: ResolvedLaunchPlan, input: ProviderLaunchInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      return b3ok({
        executable: `/usr/bin/env`,
        argv: ['sh', '-c', options.confirmSkillsFromPlan === true
          ? scriptedSession(provider, plan)
          : `printf '%s ready\\n' ${provider}; cat`],
        environment: { ...input.runtimeEnvironment },
        workingDirectory: input.workingDirectory,
        launchFingerprint: `${provider}:${plan.modelId}:${plan.effort}:${input.workingDirectory}`,
      });
    },

    async discoverSession(
      input: ProviderSessionDiscoveryInput,
    ): Promise<B3Result<ProviderSessionEvidence>> {
      if (options.discoveryFails !== undefined) {
        return b3fail(b3err('UnsupportedOperation', options.discoveryFails,
          { operation: 'provider.discoverSession', provider }, false));
      }
      return b3ok({
        providerSessionId: (options.substituteSessionId ?? input.expectedProviderSessionId) as never,
        providerNativeSessionId: `${provider}-native-${input.launchFingerprint}`,
        live: 'live',
        evidence: ['fake adapter observed its own launch'],
      });
    },

    async buildContinuation(
      input: ProviderContinuationInput,
    ): Promise<B3Result<PrivateProviderLaunch>> {
      const resuming = input.mode === 'resume' || input.mode === 'compact';
      return b3ok({
        executable: '/usr/bin/env',
        argv: ['sh', '-c', options.confirmSkillsFromPlan === true
          ? scriptedSession(provider, input.launchPlan)
          : `printf '%s %s\\n' ${provider} ${input.mode}; cat`],
        environment: { ...input.runtimeEnvironment },
        workingDirectory: input.workingDirectory,
        launchFingerprint: `${provider}:${input.mode}:${input.workingDirectory}`,
        ...(resuming ? { privateResumeHandle: input.oldSession.providerNativeSessionId } : {}),
      });
    },

    async requestInterrupt(
      _input: ProviderInterruptInput,
    ): Promise<B3Result<ProviderInterruptOutcome>> {
      if (report.interrupt.support !== 'native') {
        return b3ok({ kind: 'unsupported', reason: report.interrupt.evidence });
      }
      return b3ok({ kind: 'interrupt-requested' });
    },

    async applyControl(
      _input: ProviderControlInput,
    ): Promise<B3Result<ProviderControlOutcome>> {
      if (report.modelChange.support === 'native') return b3ok({ kind: 'applied-native' });
      if (report.modelChange.support === 'replacement-required') {
        return b3ok({ kind: 'replacement-required', reason: report.modelChange.evidence });
      }
      return b3ok({ kind: 'unsupported', reason: report.modelChange.evidence });
    },

    submitTurn: (text) => `${text}\n`,

    findConfirmationLine(observation: ProviderReplyObservation, marker: string) {
      return findMarkerLine(observation.text, marker);
    },
  };
}

/**
 * The shared line-finder: last occurrence wins, because a session that was
 * prompted twice must be judged on what it said LAST, and a provider that
 * echoes the prompt back would otherwise let the prompt confirm itself.
 */
export function findMarkerLine(text: string, marker: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.startsWith(marker)) return line;
  }
  return null;
}

export function createFakeProviderAdapters(
  options: Partial<Record<ProviderKind, FakeProviderOptions>> & {
    /** Applied to every provider, for the cases that are about all three. */
    readonly all?: FakeProviderOptions;
  } = {},
): ProviderAdapterRegistry {
  const built = {} as Record<ProviderKind, InteractiveProviderAdapter>;
  for (const provider of PROVIDER_KINDS) {
    built[provider] = createFakeProviderAdapter(
      provider, { ...options.all, ...options[provider] },
    );
  }
  return built;
}
