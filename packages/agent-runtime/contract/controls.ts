// What a control looks like crossing the Runtime↔Agents seam (§12.1).
//
// Its own file because these three types belong to neither side: Agents owns
// what a control MEANS, the Runtime owns the Run it lands on, and this is the
// vocabulary they agree on so that neither has to import the other.
import type {
  AgentRunId, ControlReplacementPlanId, ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';

/**
 * A control, as the Runtime passes it through.
 *
 * Restated here rather than imported: the Runtime never interprets a control —
 * it carries one from a caller to Agents, which owns what the names mean. A
 * structural type keeps the two definitions checkable against each other at the
 * composition root without either capability importing the other.
 */
export interface AgentControlFacts {
  readonly name: 'model' | 'effort' | 'provider-setting';
  readonly value: string;
}

export interface ControlCapabilityFacts {
  readonly agentRunId: AgentRunId;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly testedProviderVersion: string;
  readonly controls: readonly {
    readonly name: AgentControlFacts['name'];
    readonly allowedValues?: readonly string[];
    readonly support: string;
    readonly enforcement: string;
    readonly reason: string;
  }[];
}

/**
 * Three honest answers (§12.1, red gate 21). `replacement-required` is NOT a
 * failure and NOT a silent restart — it hands back the plan and stops, because
 * restarting an Agent to change its model would throw away whatever it was
 * doing without anyone asking.
 */
export type AgentControlOutcomeFacts =
  | {
    readonly kind: 'applied-native';
    readonly agentRunId: AgentRunId;
    readonly control: AgentControlFacts;
  }
  | {
    readonly kind: 'replacement-required';
    readonly replacementPlanId: ControlReplacementPlanId;
    readonly proposedLaunchPlanId: ResolvedLaunchPlanId;
  }
  | { readonly kind: 'unsupported'; readonly support: string; readonly reason: string };
