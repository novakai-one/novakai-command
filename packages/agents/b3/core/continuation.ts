// What a continuation is allowed to be (DEC-B3V4-19).
//
// Agents owns the answer because the answer lives in the pinned plan: a role
// that never permitted `resume` cannot acquire it by the Runtime asking nicely.
// The Runtime decides what a continuation DOES; this decides whether it may.
import {
  b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result, type ControlReplacementPlanId,
} from '@novakai/foundation/contract';
import type { ContinuationAllowanceInput } from '../contract/api.js';
import type { ControlReplacementPlan } from '../contract/records.js';
import type { GovernedAgentsCore } from './context.js';
import { launchPlanInvalid } from './store.js';
import { getLaunchPlan } from './plans.js';

export async function continuationAllowed(
  core: GovernedAgentsCore,
  principal: AuthenticatedPrincipal,
  input: ContinuationAllowanceInput,
): Promise<B3Result<null>> {
  const plan = await getLaunchPlan(core, principal, input.launchPlanId);
  if (!plan.ok) return plan;
  if (!plan.value.lifecyclePolicy.allowedContinuationModes.includes(input.mode)) {
    return b3fail(launchPlanInvalid([{
      path: 'mode',
      message: `is not one of the continuation modes this Run was launched under `
        + `(${plan.value.lifecyclePolicy.allowedContinuationModes.join(', ')})`,
    }]));
  }
  const capabilities = await core.providers[plan.value.provider].discoverCapabilities();
  const capability = input.mode === 'resume' ? capabilities.resume
    : input.mode === 'compact' ? capabilities.compact
      : capabilities.fresh;
  // `handover` is a Novakai concept — it starts a fresh provider context and
  // carries an artifact — so it is judged by the provider's `fresh` support.
  if (capability.support !== 'native') {
    return b3fail({
      code: 'UnsupportedOperation',
      message: `${plan.value.provider} cannot ${input.mode}: ${capability.evidence}`,
      details: {
        operation: 'agent.continue',
        provider: plan.value.provider,
        reason: capability.support,
      },
      retryable: false,
    });
  }
  return b3ok(null);
}

export async function getControlReplacementPlan(
  core: GovernedAgentsCore,
  _principal: AuthenticatedPrincipal,
  planId: ControlReplacementPlanId,
): Promise<B3Result<ControlReplacementPlan>> {
  const found = await core.store.read<ControlReplacementPlan>('controlReplacementPlan', planId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(launchPlanInvalid([
      { path: 'replacementPlanId', message: 'names no replacement plan' },
    ]));
  }
  return b3ok(found.value);
}
