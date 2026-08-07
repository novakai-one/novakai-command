// The agents public contract (Pass 2 §5 + S2a), bound to a composed context.
// Every op is the same function the CLI calls (DEC-F11 parity).
import type { AgentId, ClientOpId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { mintClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import type { Absent, ListFilter, Page, Result } from '@novakai/foundation/dist/contract/types.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  AgentDefinitionT, AgentEvent, HookAction, HookEvent, SkillDefinitionT,
  SpawnOpts, SpawnResponse, Unsubscribe,
  ProviderName,
} from '../contract/schemas.js';
import type { AgentsError, UnsupportedOperationError } from '../contract/errors.js';
import { spawnFailed, unsupportedOperation } from '../contract/errors.js';
import type { AgentsContext } from './composition.js';
import * as registry from './registry/registry.js';
import * as skillsStore from './skills/skills.js';
import { fireInjectionTrace, mergeInput, runEventHooks } from './hooks/engine.js';
import { attachLiveLane, pushContextAdvisory, type LiveLaneSender } from './live-lane/liveLane.js';

export interface AgentsContract {
  defineAgent(def: registry.DefineAgentInput, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionT, AgentsError>>;
  updateAgent(id: AgentId, patch: Partial<AgentDefinitionT>, expectedVersion: number, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionT, AgentsError>>;
  getAgent(id: AgentId): Promise<Result<AgentDefinitionT | Absent, never>>;
  listAgents(filter?: ListFilter): Promise<Result<Page<AgentDefinitionT>, AgentsError>>;
  spawnAgent(agentId: AgentId, opts?: SpawnOpts, clientOpId?: ClientOpId)
    : Promise<Result<SpawnResponse, AgentsError>>;
  setModel(agentId: AgentId, model: string, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionT, AgentsError>>;
  /**
   * OD-C3 RULED (spike 2026-07-28): mid-session model switch is SUPPORTED for
   * providers whose runtime declares a model mechanism (kimi CLI — sticky via
   * `-S <id> -m <alias>`); providers without one keep typed
   * UnsupportedOperation. Session-level only — the def's model is untouched
   * (DEC-C1: editing a def never mutates a running session, and vice versa).
   */
  setSessionModel(sessionId: SessionId, model: string)
    : Promise<Result<null, AgentsError>>;
  /** S2a: hooks engine v1 — subscriptions live on the agent object (R3-18). */
  attachHook(agentId: AgentId, event: HookEvent, action: HookAction, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionT, AgentsError>>;
  detachHook(agentId: AgentId, hookId: string, clientOpId: ClientOpId)
    : Promise<Result<AgentDefinitionT, AgentsError>>;
  /** S2a: provider-neutral skills registry (DEC-S2-4). */
  registerSkill(input: skillsStore.RegisterSkillInput, clientOpId: ClientOpId)
    : Promise<Result<SkillDefinitionT, AgentsError>>;
  getSkill(id: string): Promise<Result<SkillDefinitionT | Absent, never>>;
  listSkills(filter?: ListFilter): Promise<Result<Page<SkillDefinitionT>, AgentsError>>;
  /**
   * S2a: the contract-level session send path. onMessagePre hooks run (500ms
   * budget), buffered + fresh injections prepend the input, the adapter send
   * fires, then onMessagePost hooks. Hooks never block the send.
   */
  sendToSession(sessionId: SessionId, input: string): Promise<boolean>;
  /**
   * B1 DEC-B1-6: rebind a session that outlived the process, from its
   * persisted registry record. Returns false when the provider has no runtime
   * able to adopt it — a session never LOOKS reattached while sends go nowhere.
   */
  reattachSession(input: {
    sessionId: string;
    agentId: string;
    provider: ProviderName;
    providerConversationId: string | null;
    model: string;
    cwd: string;
  }): boolean;
  subscribeAgentEvents(handler: (e: AgentEvent) => void): Unsubscribe;
  /** Bind the live lane (R3-1) for a spawned session. */
  attachLiveLane(binding: { sessionId: string; address: string; sender: LiveLaneSender }): Unsubscribe;
  /** S2b (§22 ruling 1): push a focus-change advisory to an in-app session —
   * system context line BETWEEN turns. False for pull-only/unknown sessions. */
  pushContextAdvisory(sessionId: SessionId, line: string): boolean;
  /** End a session (terminal mini-contract close; maps to offline(closed), §7.2). */
  closeSession(sessionId: SessionId): boolean;
}

export function createAgentsContract(ctx: AgentsContext): AgentsContract {
  const publish = (e: AgentEvent): void => ctx.bus.publish(e);
  const now = (): string => new Date().toISOString();

  /** onExit fires exactly once per session, on close OR natural exit. */
  const fireExitHooks = (agentId: string, sessionId: string, def: AgentDefinitionT): void => {
    if (ctx.exitHooksFired.has(sessionId)) return;
    ctx.exitHooksFired.add(sessionId);
    void runEventHooks(ctx, def, 'onExit', { sessionId });
    void agentId;
  };

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
      // S2a (§22 ruling 5): resolve skill id refs → dirs BEFORE spawning; an
      // unknown id fails typed — no session starts without its declared skills.
      const resolved = await skillsStore.resolveSkillDirs(ctx, def.skills);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const adapter = ctx.adapters[def.provider];
      let spawned;
      try {
        spawned = await adapter.spawn(agentId, def.provider, {
          ...(opts ?? {}), model, skills: [...resolved.value, ...(opts?.skills ?? [])],
        });
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
          fireExitHooks(agentId, spawned.sessionId, def);
          publish({
            type: 'offline', agentId, sessionId: spawned.sessionId, at: e.at,
            reason: ctx.closedSessions.has(spawned.sessionId) ? 'closed' : 'exited',
          });
        }
      });
      // S2a hooks: onSpawn fires on the spawn path (2s budget); injections are
      // buffered and prepend the session's FIRST input (DEC-S2-2). A failing
      // hook never blocks the spawn (DEC-S2-3).
      const spawnHooks = await runEventHooks(ctx, def, 'onSpawn', { sessionId: spawned.sessionId });
      if (spawnHooks.injections.length > 0) {
        ctx.pendingInjections.set(spawned.sessionId, spawnHooks.injections);
      }
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

    // OD-C3 RULED (spike: spec/pass2-s2/OD-C3-spike.md): route to the session's
    // adapter when it exposes a real model mechanism; otherwise the honest
    // typed UnsupportedOperation stands (mock, unverified TUI hosts).
    async setSessionModel(sessionId, model) {
      const meta = ctx.sessions.get(sessionId);
      const adapter = meta
        ? ctx.adapters[meta.provider]
        : Object.values(ctx.adapters).find((a) => a.attach(sessionId));
      if (adapter?.setSessionModel?.(sessionId, model)) {
        return { ok: true, value: null };
      }
      return {
        ok: false,
        error: unsupportedOperation('setSessionModel',
          'this provider/runtime declares no mid-session model-switch mechanism', 'OD-C3'),
      };
    },

    attachHook: (agentId, event, action, clientOpId) =>
      registry.attachHook(ctx, agentId, { event, action }, clientOpId),
    detachHook: (agentId, hookId, clientOpId) =>
      registry.detachHook(ctx, agentId, hookId, clientOpId),

    registerSkill: (input, clientOpId) => skillsStore.registerSkill(ctx, input, clientOpId),
    getSkill: (id) => skillsStore.getSkill(ctx, id),
    listSkills: (filter) => skillsStore.listSkills(ctx, filter),

    async sendToSession(sessionId, input) {
      const meta = ctx.sessions.get(sessionId);
      const adapter = meta
        ? ctx.adapters[meta.provider]
        : Object.values(ctx.adapters).find((a) => a.attach(sessionId));
      if (!adapter) return false;
      let out = input;
      if (meta) {
        const found = await registry.getAgent(ctx, meta.agentId as AgentId);
        if (found.ok && !isAbsent(found.value)) {
          // buffered injections (onSpawn/onMessagePost) prepend FIRST, then
          // this event's onMessagePre injections (creation order within each).
          const pending = ctx.pendingInjections.get(sessionId) ?? [];
          ctx.pendingInjections.delete(sessionId);
          const pre = await runEventHooks(ctx, found.value, 'onMessagePre', { sessionId, messageText: input });
          const injections = [...pending, ...pre.injections];
          out = mergeInput(injections, input);
          const sent = adapter.send(sessionId, out);
          if (sent) {
            // L14: provenance traces fire ONLY on send success — an injection
            // that never went out is neither traced nor consumed.
            for (const inj of injections) await fireInjectionTrace(ctx, inj);
          } else if (injections.length > 0) {
            // send failed: re-buffer the injections for the next attempt.
            ctx.pendingInjections.set(sessionId, [
              ...injections, ...(ctx.pendingInjections.get(sessionId) ?? []),
            ]);
          }
          // onMessagePost runs even when the send fails (the event happened);
          // its injections buffer for the next input.
          const post = await runEventHooks(ctx, found.value, 'onMessagePost', { sessionId, messageText: input });
          if (post.injections.length > 0) {
            ctx.pendingInjections.set(sessionId, [
              ...(ctx.pendingInjections.get(sessionId) ?? []), ...post.injections,
            ]);
          }
          return sent;
        }
      }
      // Session unknown to this process (DEC-C1: sessions are in-memory) —
      // no agent context, so no hooks; recorded in NOTES.md.
      return adapter.send(sessionId, out);
    },

    subscribeAgentEvents: (handler) => ctx.bus.subscribe(handler),

    reattachSession(input) {
      const adapter = ctx.adapters[input.provider];
      if (typeof adapter.adopt !== 'function') return false;
      const alreadyKnown = ctx.sessions.has(input.sessionId);
      if (!adapter.adopt(input)) return false;
      ctx.sessions.set(input.sessionId, { agentId: input.agentId, provider: input.provider });
      // A freshly spawned replacement is already subscribed and online. Only
      // process-start reattachment needs to rebuild those bindings.
      if (alreadyKnown) return true;
      // Same event wiring as a fresh spawn (R3-17), so presence and exit hooks
      // behave identically for a reattached session.
      adapter.subscribe(input.sessionId, (e) => {
        if (e.type === 'activity') {
          publish({ type: 'activity', agentId: input.agentId, sessionId: input.sessionId, at: e.at, activity: e.activity });
        } else if (e.type === 'exited') {
          publish({
            type: 'offline', agentId: input.agentId, sessionId: input.sessionId, at: e.at,
            reason: ctx.closedSessions.has(input.sessionId) ? 'closed' : 'exited',
          });
        }
      });
      publish({ type: 'online', agentId: input.agentId, sessionId: input.sessionId, at: now() });
      return true;
    },
    attachLiveLane: (binding) => attachLiveLane(ctx, binding),

    pushContextAdvisory: (sessionId, line) => pushContextAdvisory(ctx, sessionId, line),

    closeSession(sessionId) {
      const meta = ctx.sessions.get(sessionId);
      const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
      if (!adapter) return false;
      ctx.closedSessions.add(sessionId);
      if (meta) {
        void registry.getAgent(ctx, meta.agentId as AgentId).then((found) => {
          if (found.ok && !isAbsent(found.value)) fireExitHooks(meta.agentId, sessionId, found.value);
        });
      }
      return adapter.close(sessionId);
    },
  };
}
