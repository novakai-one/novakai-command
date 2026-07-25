/**
 * Watchdog identity (F3): find-or-create the durable `nvk-watchdog` agent the
 * seat-watch sends #team alerts AS — never the human principal. The agent is
 * an ops service, so it is unioned into EVERY team and EVERY mission record:
 * delivery is gated by recipient allowlists grown from co-membership (union
 * semantics over team/mission refs, messagingV2/policy), and a watchdog tied
 * to one arbitrary mission would terminally fail every other recipient.
 * The union is idempotent — a reboot appends nothing. Null = no mission
 * record to attach to (the alert sink degrades to log-only for the run).
 * F8: status stays 'spawning' — AgentBlock has no service-appropriate value
 * ('live' would claim a Presence that does not exist), and 'spawning' is
 * authenticatable, so the people-directory row is honest.
 */
import type { ObjectModel } from '../../objectModel/index.js';

export const WATCHDOG_AGENT_NAME = 'nvk-watchdog';
export const WATCHDOG_TEAM_NAME = 'ops';

function firstMissionId(objectModel: ObjectModel): string | null {
  const missionId = objectModel.listMissions()[0]?.['id'];
  return typeof missionId === 'string' ? missionId : null;
}

function ensureOpsTeam(objectModel: ObjectModel, missionId: string): string {
  const team = objectModel.listTeams().find((entry) => entry['name'] === WATCHDOG_TEAM_NAME);
  const teamId = team?.['id'];
  return typeof teamId === 'string' ? teamId : objectModel.createTeam({ name: WATCHDOG_TEAM_NAME, missionId });
}

function ensureAgent(objectModel: ObjectModel, missionId: string): string {
  const existing = objectModel.listAgents().find((agent) => agent.name === WATCHDOG_AGENT_NAME);
  if (existing) return existing.id;
  return objectModel.createAgent({
    name: WATCHDOG_AGENT_NAME, provider: 'ops',
    teamId: ensureOpsTeam(objectModel, missionId), missionId,
  });
}

function allMembershipRefs(objectModel: ObjectModel): Array<{ kind: string; value: string }> {
  const teamIds = objectModel.listTeams().map((team) => team['id']);
  const missionIds = objectModel.listMissions().map((mission) => mission['id']);
  return [
    ...teamIds.filter((id): id is string => typeof id === 'string').map((value) => ({ kind: 'team', value })),
    ...missionIds.filter((id): id is string => typeof id === 'string').map((value) => ({ kind: 'mission', value })),
  ];
}

/** Call BEFORE messagingV2 boots: the boot policy syncs must already see the
 * unioned refs, or recipients' allowlists lack the watchdog until the next
 * launch-triggered sync. Missions/teams created mid-run join on restart. */
export function ensureWatchdogIdentity(objectModel: ObjectModel): string | null {
  const missionId = firstMissionId(objectModel);
  if (missionId === null) return null;
  const agentId = ensureAgent(objectModel, missionId);
  objectModel.unionAgentRefs(agentId, allMembershipRefs(objectModel));
  return agentId;
}
