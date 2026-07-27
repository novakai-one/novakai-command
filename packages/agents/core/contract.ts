// The agents-lite public contract (Pass 2 §5), bound to a composed context.
// Every op is the same function the CLI calls (DEC-F11 parity).
import type { AgentId, ClientOpId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { mintClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import type { Absent, ListFilter, Page, Result } from '@novakai/foundation/dist/contract/types.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  AgentDefinitionLiteT as AgentDefinitionLite, AgentEvent, SpawnOpts, SpawnResponse, Unsubscribe,
} from '../contract/schemas.js';
import type { AgentsError, UnsupportedOperationError } from '../contract/errors.js';
import { spawnFailed, unsupportedOperation } from '../contract/errors.js';
import type { AgentsContext } from './composition.js';
import * as registry from './registry/registry.js';
import { attachLiveLane, type LiveLaneSender } from './live-lane/liveLane.js';

export interface AgentsContract {
  defineAgent(def: registry.DefineAgentInput, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionLite, AgentsError>>;
  updateAgent(id: AgentId, patch: Partial<AgentDefinitionLite>, expectedVersion: number, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionLite, AgentsError>>;
  getAgent(id: AgentId): Promise<Result<AgentDefinitionLite | Absent, never>>;
  listAgents(filter?: ListFilter): Promise<Result<Page<AgentDefinitionLite>, AgentsError>>;
  spawnAgent(agentId: AgentId, opts?: SpawnOpts, clientOpId?: ClientOpId)
    : Promise<Result<SpawnResponse, AgentsError>>;
  setModel(agentId: AgentId, model: string, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionLite, AgentsError>>;
  setSessionModel(sessionId: SessionId, model: string)
    : Promise<Result<never, UnsupportedOperationError>>;
  attachHook(agentId: AgentId, event: string, action: { kind: string; id: string }, clientOpId: ClientOpId)
    : Promise<Result<never, UnsupportedOperationError>>;
  subscribeAgentEvents(handler: (e: AgentEvent) => void): Unsubscribe;
  /** Bind the live lane (R3-1) for a spawned session. */
  attachLiveLane(binding: { sessionId: string; address: string; sender: LiveLaneSender }): Unsubscribe;
  /** End a session (terminal mini-contract close; maps to offline(closed), §7.2). */
  closeSession(sessionId: SessionId): boolean;
}

export function createAgentsContract(ctx: AgentsContext): AgentsContract {
  const publish = (e: AgentEvent): void => ctx.bus.publish(e);
  const now = (): string => new Date().toISOString();

  return {
    defineAgent: (def, clientOpId) => registry.defineAgent(ctx, def, clientOpId),
    updateAgent: (id, patch, expectedVersion, clientOpId) =>
      registry.updateAgent(ctx, id, patch, expectedVersion, clientOpId),
    getAgent: (id) => registry.getAgent(ctx, id),
    listAgents: (filter) => registry.listAgents(ctx, filter),

    async spawnAgent(agentId, opts, clientOpId) {
      void (clientOpId ?? mintClientOpId()); // spawn mutates no stored object (R3-18); id accepted for trace symmetry
      const found = await registry.getAgent(ctx, agentId);
      if (!found.ok || isAbsent(found.value)) {
        return {
          ok: false,
          error: err('NotFound', `no agent with id "${agentId}"`, { ref: { kind: 'agent', id: agentId } }, false),
        };
      }
      const def = found.value;
      const model = opts?.model ?? def.model; // at-spawn override GUARANTEED (AGT-003)
      const adapter = ctx.adapters[def.provider];
      let spawned;
      try {
        spawned = await adapter.spawn(agentId, def.provider, { ...(opts ?? {}), model });
      } catch (cause) {
        // C §11: provider outage = typed error + presence offline; never silent stall
        publish({
          type: 'offline', agentId, sessionId: `sess_failed_${Date.now()}`, at: now(),
          reason: 'provider_error',
        });
        return {
          ok: false,
          error: spawnFailed(def.provider, agentId, cause instanceof Error ? cause.message : String(cause)),
        };
      }
      ctx.sessions.set(spawned.sessionId, { agentId, provider: def.provider });
      // R3-17: wrap the session's raw PtyEvents and re-publish as agentEvent.
      adapter.subscribe(spawned.sessionId, (e) => {
        if (e.type === 'activity') {
          publish({ type: 'activity', agentId, sessionId: spawned.sessionId, at: e.at, activity: e.activity });
        } else if (e.type === 'exited') {
          publish({
            type: 'offline', agentId, sessionId: spawned.sessionId, at: e.at,
            reason: ctx.closedSessions.has(spawned.sessionId) ? 'closed' : 'exited',
          });
        }
      });
      publish({ type: 'spawned', agentId, sessionId: spawned.sessionId, at: now() });
      publish({ type: 'online', agentId, sessionId: spawned.sessionId, at: now() });
      return {
        ok: true,
        value: {
          sessionId: spawned.sessionId, agentId, provider: def.provider, model,
        },
      };
    },

    setModel: (id, model, clientOpId) => registry.setModel(ctx, id, model, clientOpId),

    // OD-C3-pending (R3-15): model-switch is NOT in the ratified mini-contract.
    async setSessionModel(_sessionId, _model) {
      return {
        ok: false,
        error: unsupportedOperation('setSessionModel',
          'mid-session model switch is not in the ratified terminal mini-contract', 'OD-C3'),
      };
    },

    // OD-C2 (R3-16): hook engine ships S2; signature declared for stability.
    async attachHook(_agentId, _event, _action, _clientOpId) {
      return {
        ok: false,
        error: unsupportedOperation('attachHook', 'hook engine ships in S2', 'OD-C2'),
      };
    },

    subscribeAgentEvents: (handler) => ctx.bus.subscribe(handler),

    attachLiveLane: (binding) => attachLiveLane(ctx, binding),

    closeSession(sessionId) {
      const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
      if (!adapter) return false;
      ctx.closedSessions.add(sessionId);
      return adapter.close(sessionId);
    },
  };
}
