import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type { ComposedAgentRuns } from '../../../agent-runtime/contract/index.js';
import type { GovernedAgentsContract } from '../../../agents/governed/contract/index.js';
import type { ProviderUsageEvidenceContract } from '../../../agents/contract/index.js';
import type { MessagingRuntimeApi } from '../../../messaging/contract/index.js';
import {
  composeSupervision, createTemplateCatalogue, type SupervisionCore,
} from '../../../supervision/public/index.js';
import type { RecordDriftStatusSubmissionInput } from '../../../supervision/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import {
  watcherInstallAuthority, watchRuleAccess, watchRuleGeneration,
} from './supervision-ports.js';
import { createTranscriptUsagePort } from './usage-transcript-port.js';

type UsageMessaging = Pick<
  MessagingRuntimeApi,
  'listProviderSessions' | 'listTranscriptLines'
>;

interface RuntimeSupervisionOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly agents: GovernedAgentsContract;
  readonly terminal: TerminalContract;
  readonly usageEvidence: ProviderUsageEvidenceContract;
  readonly messaging: UsageMessaging;
  readonly watcherTemplates: ReturnType<typeof createTemplateCatalogue>;
  readonly runs: () => ComposedAgentRuns | null;
}

/** Prove a submitted drift outcome against Terminal-owned durable facts. */
function driftAuthority(terminal: TerminalContract): {
  verify(input: RecordDriftStatusSubmissionInput): Promise<B3Result<null>>;
} {
  const principal = { id: 'sys_supervision', kind: 'system', verifiedScopes: [] } as const;
  const mismatch = (reason: string) => b3fail(b3err(
    'WatcherConflict', 'Terminal facts do not match the drift submission', { reason }, true,
  ));
  return {
    async verify(input) {
      const reservation = await terminal.getNotificationInputReservation(
        principal, input.expectedNotificationInputReservationId,
      );
      if (!reservation.ok) return reservation;
      if (reservation.value.state !== 'committed'
        || reservation.value.notificationId !== input.expectedNotificationId
        || reservation.value.deliveryEffectKey !== input.expectedEffectKey
        || reservation.value.terminalInputAttemptId !== input.expectedTerminalInputAttemptId) {
        return mismatch('reservation-tuple');
      }
      const attempt = await terminal.getTerminalInputAttempt(
        principal, input.expectedTerminalInputAttemptId,
      );
      if (!attempt.ok) return attempt;
      if (attempt.value.source !== 'system-notification'
        || attempt.value.notificationInputReservationId
          !== input.expectedNotificationInputReservationId
        || attempt.value.deliveryEffectKey !== input.expectedEffectKey
        || attempt.value.outcome !== input.submission.state
        || attempt.value.submittedAt !== input.submission.submittedAt
        || attempt.value.providerTurnId !== input.submission.providerTurnId) {
        return mismatch('terminal-attempt-tuple');
      }
      return b3ok(null);
    },
  };
}

const unavailable = () => b3fail(b3err(
  'RuntimeUnavailable', 'Agent Runtime is not composed', {}, true,
));

/** Compose Supervision against Runtime and Messaging contract-only readers. */
export function composeRuntimeSupervision(options: RuntimeSupervisionOptions): SupervisionCore {
  const current = (): ComposedAgentRuns | undefined => options.runs() ?? undefined;
  return composeSupervision({
    root: options.root,
    dataRoot: options.dataRoot,
    installAuthority: watcherInstallAuthority(options.agents, current),
    watchRuleAccess: watchRuleAccess(current),
    watchRuleGeneration: watchRuleGeneration(current),
    templates: options.watcherTemplates,
    driftSubmissionAuthority: driftAuthority(options.terminal),
    occurrenceRelationships: {
      async isDirectManagedChild(principal, input) {
        let parentAgentId = input.parentAgentId;
        if (parentAgentId === undefined) {
          if (input.parentAgentRunId === undefined || options.runs() === null) return b3ok(false);
          const parent = await options.runs()!.getAgentRun(principal, input.parentAgentRunId);
          if (!parent.ok) return parent;
          parentAgentId = parent.value.agent.agentId;
        }
        const children = await options.agents.listChildren(principal, parentAgentId);
        if (!children.ok) return children;
        return b3ok(children.value.some((relationship) =>
          relationship.childAgentId === input.childAgentId
          && (input.parentAgentRunId === undefined
            || relationship.createdFromRunId === input.parentAgentRunId)));
      },
    },
    usage: {
      runs: {
        async getUsageRun(principal, agentRunId) {
          const runs = options.runs();
          return runs === null ? unavailable() : runs.usageRuns.getUsageRun(principal, agentRunId);
        },
        async listUsageRuns(principal, agentId) {
          const runs = options.runs();
          return runs === null ? unavailable() : runs.usageRuns.listUsageRuns(principal, agentId);
        },
        async resolveUsageRunByProviderSession(principal, providerSessionId) {
          const runs = options.runs();
          return runs === null
            ? unavailable()
            : runs.resolveUsageRunByProviderSession(principal, providerSessionId);
        },
        async resolveCurrentRunByAgent(principal, agentId) {
          const runs = options.runs();
          return runs === null ? unavailable() : runs.resolveCurrentRunByAgent(principal, agentId);
        },
        async getRunOccurrenceEvent(principal, eventId) {
          const runs = options.runs();
          return runs === null ? unavailable() : runs.getRunOccurrenceEvent(principal, eventId);
        },
      },
      evidence: options.usageEvidence,
      transcript: createTranscriptUsagePort({
        agents: options.agents,
        messaging: options.messaging,
      }),
    },
  });
}
