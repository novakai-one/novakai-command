// The launch facts a Run is pinned to.
//
// Its own file because it is the one fact TWO seams speak about: Agents pins it
// (`AgentsPort.getLaunchPlan`) and the provider launches from it
// (`ProviderPort.prepareLaunch`). Leaving it in `ports.ts` while the provider
// seam lived in `provider-ports.ts` made an import CYCLE — type-only and so
// erased at runtime, but the architecture test refuses it either way, and it is
// right to: a cycle says the two files are really one, and these two are not.
import type {
  AgentId, AgentRoleProfileId, ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';
import type { ContinuationMode } from './runs.js';

/** The launch facts a Run is pinned to. Runtime reads these; it never edits them. */
export interface LaunchPlanFacts {
  readonly id: ResolvedLaunchPlanId;
  readonly agentId: AgentId;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly modelId: string;
  readonly effort: string;
  readonly workingDirectory: string;
  readonly skills: readonly { readonly id: string; readonly version: number; readonly digest: string }[];
  readonly skillsConfirmationGate:
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'required-two-turn';
        readonly confirmationMarker: string;
        readonly onFailure: 'terminate-run-and-record-drift';
      };
  /**
   * The role's watcher policy, pinned into the immutable plan at resolution.
   * Optional in the FACTS because a host composed without Supervision
   * genuinely has none to read — a Runtime that invented one would be
   * installing watchers no role ever asked for.
   */
  readonly supervisionPolicy?: {
    readonly activityDrift: 'required' | 'disabled-explicitly';
    readonly activityDriftTemplateRef?: {
      readonly id: string; readonly version: number; readonly digest: string;
    };
    readonly requiredWatcherTemplates: readonly {
      readonly id: string; readonly version: number; readonly digest: string;
    }[];
    readonly parentNotificationMode: 'queue-only' | 'next-turn-context' | 'start-turn';
  };
  readonly lifecyclePolicy: {
    readonly onSupervisorFinal:
      | 'assign-human' | 'assign-nearest-live-ancestor' | 'remain-orphaned';
    readonly allowedContinuationModes: readonly ContinuationMode[];
  };
  readonly spawnPolicy: {
    /**
     * The child roles this Run may spawn. The Runtime asks for exactly these
     * when it issues the Run's own grant — Agents then intersects them down to
     * what the CALLER actually held, so the grant can only ever shrink.
     */
    readonly allowedChildRoleIds: readonly AgentRoleProfileId[];
    readonly maxLiveChildren?: number;
  };
}
