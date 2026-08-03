import {
  canonicalJson,
  deterministicId,
  providerTurnBoundaryProfileId,
  type IsoUtc,
  type TranscriptLineId,
} from '@novakai/foundation/contract';
import type {
  ProviderTurnBoundaryInput,
  ProviderTurnBoundaryObservation,
  ProviderTurnBoundaryProfile,
} from '../../contract/providers.js';
import type { ProviderKind } from '../../contract/records.js';

const schemaDigest = (provider: ProviderKind): string =>
  deterministicId('schema', ['provider-turn-source', provider]).slice('schema_'.length);

export function boundaryProfile(
  provider: ProviderKind,
  executableVersion: string,
): ProviderTurnBoundaryProfile {
  const payload = {
    provider,
    executableVersion,
    sourceFormatSchemaDigest: schemaDigest(provider),
    inputFrame: {
      discriminatorPath: '/frame/type',
      discriminatorValue: 'input-start',
      logicalUtf8TextPath: '/frame/input',
      providerNativeSessionIdPath: '/frame/sessionId',
      providerNativeTurnIdPath: '/frame/turnId',
    },
    completionFrame: {
      discriminatorPath: '/frame/type',
      terminalDiscriminatorValues: ['response-completed'] as const,
      providerNativeSessionIdPath: '/frame/sessionId',
      providerNativeTurnIdPath: '/frame/turnId',
      terminalSemanticsEvidenceDigest: deterministicId(
        'evidence', ['provider-terminal-semantics', provider, executableVersion],
      ).slice('evidence_'.length),
    },
    correlation: {
      mode: 'shared-provider-native-turn-id' as const,
      inputAndCompletionPathsRequired: true as const,
    },
    ordering: {
      mode: 'strict-monotonic-source-position' as const,
      intermediateToolFramesMustShareCorrelation: true as const,
      sourceGapInvalidatesProof: true as const,
    },
    evidenceDigestRecipe: 'sha256(canonical-json(profileId,providerNativeSessionId,providerNativeTurnIdOrCorrelationId,inputPosition,completionPosition,inputSourceDigest,completionSourceDigest,orderedIntermediateSourceDigests))' as const,
  };
  return { id: providerTurnBoundaryProfileId(canonicalJson(payload)), ...payload };
}

/** Deterministic native framing used only by the synthetic provider adapter. */
export function fakeBoundaryObservation(
  profile: ProviderTurnBoundaryProfile,
  input: ProviderTurnBoundaryInput,
): ProviderTurnBoundaryObservation {
  const correlation = `fake-native-turn:${input.providerTurnId}`;
  const submittedInputSourcePosition = `fake:${input.providerTurnId}:input`;
  const completionSourcePosition = `fake:${input.providerTurnId}:completed`;
  const framingEvidenceDigest = deterministicId('evidence', [
    profile.id,
    input.providerNativeSessionId,
    correlation,
    submittedInputSourcePosition,
    completionSourcePosition,
    input.inputDigest,
  ]).slice('evidence_'.length);
  return {
    kind: 'proven',
    providerCorrelationId: correlation,
    providerNativeTurnId: correlation,
    submittedInputSourcePosition,
    completionSourcePosition,
    completionSourceCommittedAt: '2026-08-03T00:00:00.000Z' as IsoUtc,
    submittedInputEvidenceDigest: input.inputDigest,
    sourceLineIds: [deterministicId('transcriptLine', [
      input.transcriptBindingId, correlation,
    ]) as TranscriptLineId],
    resultingWatermark: completionSourcePosition,
    turnBoundaryProfileId: profile.id,
    framingEvidenceDigest,
    limitations: [],
  };
}

export const unavailableBoundary = (): ProviderTurnBoundaryObservation => ({
  kind: 'unavailable',
  reason: 'source-unavailable',
  evidenceRefs: ['provider source must be observed by Transcript'],
});
