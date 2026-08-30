import { brandClock } from '../../core/clock.js';
import { present } from '../../core/sparse.js';
import type {
  ProviderDispatchResult,
  ProviderSend,
  ProviderSendInput,
} from '../ports/provider-send.js';
import type { AgentsDoor } from './agents-door.js';

/** Provider-send binds one door op; the directory binds the other five. */
type ProviderSendDoor = Pick<AgentsDoor, 'executeProviderTurn'>;

function providerText(input: ProviderSendInput): string {
  if (input.screenContext === undefined) return input.text;
  return `[novakai context] ${JSON.stringify(input.screenContext)}\n${input.text}`;
}

/**
 * Adapts the Agents door to one completed provider CLI turn. Every Agents
 * failure maps to Messaging's own `ProviderSessionUnavailable` vocabulary —
 * provider variability stays behind this seam, so core never learns an
 * Agents error code.
 *
 * The wall clock is read here, at the anti-corruption seam — never inside
 * core; tests inject `rawClock` to control `dispatchedAt`. An Agents op
 * that throws rather than returning a typed failure propagates uncaught to
 * the host caller; the send journal (written before dispatch) is the
 * recovery record.
 */
export function createAgentsProviderSend(
  agents: ProviderSendDoor,
  rawClock: () => string = () => new Date().toISOString(),
): ProviderSend {
  const wallClock = brandClock(rawClock);
  return {
    async dispatch(input): Promise<ProviderDispatchResult> {
      const dispatchedAt = wallClock();
      const outcome = await agents.executeProviderTurn({
        agentId: input.targetAgentId,
        text: providerText(input),
        ...present('resumeId', input.resumeId),
      });
      if (!outcome.ok) {
        return {
          ok: false,
          code: 'ProviderSessionUnavailable',
          message: outcome.error.message,
        };
      }
      return {
        ok: true,
        dispatchedAt,
        certainty: 'unconfirmed',
        response: outcome.value.response,
      };
    },
  };
}
