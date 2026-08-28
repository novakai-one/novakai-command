// `b3.*` wire adapter: identity, controller bookkeeping and live output only.
import {
  agentRunPrincipalId, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type ControllerAttachmentId,
  type HumanPrincipalId, type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import { HUMAN_SCOPES } from '../../../agents/b3/contract/index.js';
import {
  DEFAULT_STALE_AFTER_MS, UNFINISHED_TERMINAL_SESSION_STATUSES,
} from '../../../terminal/contract/index.js';
import type { CallerIdentity, CallerSession, MethodTable } from '../../contract/protocol.js';
import type { DispatchedCall } from '../transport/server.js';
import { composeRuntimeHost, type RuntimeHost, type RuntimeHostOptions } from './composition.js';
import { buildRuntimeHostMethods } from './methods.js';
import { readAllTerminalSessions } from './terminal-paging.js';
import { buildRuntimeHostAgentMethods } from './agent-methods.js';
import { buildMessagingRuntimeMethods } from './messaging-runtime-methods.js';
import { buildRuntimeHostSupervisionMethods } from './supervision-methods.js';

/** Comfortably inside the stale window, so a live window is never called gone. */
const SIGHTING_INTERVAL_MS = Math.floor(DEFAULT_STALE_AFTER_MS / 3);

interface OpenedController {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
}

/** The attach/detach result as it comes back off the method table. */
function attachmentIn(result: unknown): OpenedController | null {
  const outcome = result as
    { ok?: boolean; value?: OpenedController & { id?: ControllerAttachmentId } };
  if (!outcome?.ok || outcome.value === undefined) return null;
  const attachmentId = outcome.value.id ?? outcome.value.attachmentId;
  if (attachmentId === undefined || outcome.value.terminalSessionId === undefined) return null;
  return { attachmentId, terminalSessionId: outcome.value.terminalSessionId };
}

/** Host inputs for the runtime-host transport adapter. */
export interface RuntimeHostWireOptions extends RuntimeHostOptions {
  readonly principalId?: HumanPrincipalId;
  /**
   * The runtime has been stopped through its own contract. A serving daemon
   * uses this to release the port; an in-process host may ignore it.
   */
  readonly onRuntimeStopped?: () => void;
}

/** Just enough of a listening transport for the adapter to push frames into. */
interface EventSink {
  broadcast(name: string, data: unknown): void;
}

/** Authenticated method table and lifecycle exposed to a listening host. */
export interface RuntimeHostWire {
  readonly runtime: RuntimeHost;
  /** Every `b3.*` method, ready to merge into a host's table. */
  readonly methods: MethodTable;
  /** Who a connection is — decided at the upgrade, refused rather than downgraded. */
  identifyCaller(connection: URL): CallerIdentity | null;
  onDispatch(call: DispatchedCall): void;
  onDisconnect(connectionId: number): void;
  /**
   * The transport is listening: live events start leaving as v1 frames, the
   * heartbeat starts, and the machine is CLAIMED before a single command is
   * accepted (a second host must never serve a request it may not have served).
   *
   * Throws when the claim is refused — a caller that came up anyway would be a
   * runtime with no right to the PTYs it is about to own.
   */
  serve(sink: EventSink): Promise<void>;
  close(): Promise<void>;
}

/** Compose the runtime-host wire without taking ownership of the listening socket. */
export async function composeRuntimeHostWire(options: RuntimeHostWireOptions): Promise<RuntimeHostWire> {
  // Live events leave as ordinary v1 event frames, exactly as terminal output
  // does. Composition is where that is decided: the capability publishes, and
  // the HOST chooses who hears it (§12.6 — server transports, it owns no state).
  let broadcastEvent: (kind: string, payload: Readonly<Record<string, unknown>>) => void
    = () => undefined;
  const runtime = await composeRuntimeHost({
    ...options,
    publish: (kind, payload) => {
      options.publish?.(kind, payload);
      broadcastEvent(kind, payload);
    },
  });
  const principalId = options.principalId ?? ('person_chris' as HumanPrincipalId);

  /**
   * Who a connection is. A spawned Agent presents the Run credential the
   * Runtime handed it; anything else is the local human. A credential that does
   * not verify is REFUSED rather than downgraded — a forged Agent identity that
   * silently became "Chris" would hand it every scope Chris has.
   */
  const identifyCaller = (connection: URL): CallerIdentity | null => {
    const agentRunId = connection.searchParams.get('agentRunId');
    const runToken = connection.searchParams.get('runToken');
    if (agentRunId === null && runToken === null) return { kind: 'human' };
    if (agentRunId === null || runToken === null) return null;
    if (!runtime.credentials.verify(agentRunId as never, runToken)) return null;
    return { kind: 'agent-run', agentRunId };
  };

  const principalFor = (session: CallerSession | undefined): AuthenticatedPrincipal => {
    if (session?.identity.kind === 'agent-run') {
      const agentRunId = session.identity.agentRunId as AgentRunId;
      return {
        // Derived from the Run, because this id is what every record it writes
        // stores as `createdBy`. A constant here would leave three generations
        // of Agents indistinguishable in the trace.
        id: agentRunPrincipalId(agentRunId),
        kind: 'agent-run',
        agentRunId,
        // An Agent's authority comes from its GRANTS, never from the socket.
        verifiedScopes: [],
      };
    }
    return { id: principalId, kind: 'human', verifiedScopes: HUMAN_SCOPES };
  };

  const methods = {
    ...buildRuntimeHostMethods({
      runtime, principalId,
      // Announced, not acted on here: whether a stopped runtime should exit its
      // process is the HOST's decision (a serving daemon exits; an in-process
      // test host does not), so this adapter only forwards the fact.
      onRuntimeStopped: () => { options.onRuntimeStopped?.(); },
    }),
    ...buildRuntimeHostAgentMethods({
      runtime,
      principalFor,
      contextFor: (principal, _session, clientOpId) => ({
        principal,
        clientOpId,
        traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      }),
    }),
    ...buildMessagingRuntimeMethods({
      messaging: runtime.messaging,
      // The Run→Agent join, read from the Runtime's own records. An Agent Run
      // may read ITS Agent and no other, and this is how the wire finds out
      // which one that is without believing anything the caller said.
      agentOfRun: async (agentRunId) => {
        const view = await runtime.runs.getAgentRun(
          { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
          agentRunId as AgentRunId,
        );
        return view.ok ? view.value.agent.agentId : null;
      },
      principalFor,
    }),
    ...buildRuntimeHostSupervisionMethods({
      supervision: runtime.supervision,
      principalFor,
      activityGenerationFor: async (agentRunId) => {
        const view = await runtime.runs.getAgentRun(
          { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, agentRunId,
        );
        return view.ok ? view.value.run.activityGeneration : null;
      },
    }),
  };

  const following = new Set<string>();
  /** Which windows each connection opened — the host's own fact (§13.4). */
  const controllersByConnection = new Map<number, Map<string, OpenedController>>();
  let sightings: ReturnType<typeof setInterval> | null = null;

  const systemContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });

  function remember(call: DispatchedCall): void {
    const attachment = attachmentIn(call.result);
    if (!attachment) return;
    const held = controllersByConnection.get(call.connectionId) ?? new Map();
    if (call.method === 'b3.terminal.detach') held.delete(attachment.attachmentId);
    else held.set(attachment.attachmentId, attachment);
    controllersByConnection.set(call.connectionId, held);
  }

  /**
   * The window is gone, so it is detached — not killed, and not left inflating
   * the count forever. §13.4: closing a socket IS detach.
   */
  async function detachConnection(connectionId: number): Promise<void> {
    const held = controllersByConnection.get(connectionId);
    controllersByConnection.delete(connectionId);
    for (const controller of held?.values() ?? []) {
      await runtime.terminal.detachController(systemContext(), controller);
    }
  }

  /** Everything the host can still see, for Terminal to judge (§13.4). */
  async function reportSightings(): Promise<void> {
    const visible: ControllerAttachmentId[] = [];
    for (const held of controllersByConnection.values()) {
      for (const controller of held.values()) visible.push(controller.attachmentId);
    }
    await runtime.terminal.system.observeControllers(systemContext(), {
      attachmentIds: visible,
    });
  }

  /** Push one session's live output until it ends. Idempotent per session. */
  function follow(sink: EventSink, terminalSessionId: string): void {
    if (following.has(terminalSessionId)) return;
    following.add(terminalSessionId);
    void (async () => {
      for await (const frame of runtime.terminal.readTerminalStream(
        { id: principalId, kind: 'human', verifiedScopes: [] },
        { terminalSessionId: terminalSessionId as never },
      )) {
        if (!frame.ok) break;
        sink.broadcast('b3.terminal.output', { terminalSessionId, frame: frame.value });
        if (frame.value.kind === 'exit') break;
      }
      following.delete(terminalSessionId);
    })();
  }

  async function followNewSessions(sink: EventSink): Promise<void> {
    // A5-05 replaced `state: 'live'` with the status set it always meant: the
    // three statuses that are not final. Every one of them, paged through, so
    // a busy machine does not quietly stop following its newest tabs.
    const listed = await readAllTerminalSessions(
      runtime.terminal, { id: principalId, kind: 'human', verifiedScopes: [] },
      { status: UNFINISHED_TERMINAL_SESSION_STATUSES },
    );
    if (!listed.ok) return;
    for (const view of listed.value) follow(sink, view.session.id);
  }

  /**
   * Set once the transport is listening. Until then a dispatch cannot have
   * happened, so an unset sink is not a state any caller can observe.
   */
  let events: EventSink | null = null;

  return {
    runtime,
    methods,
    identifyCaller,

    onDispatch(call: DispatchedCall) {
      if (call.method === 'b3.terminal.attach' || call.method === 'b3.terminal.detach') {
        remember(call);
      }
      // A controller that opened or attached wants to SEE the session, so the
      // host starts pushing its output as ordinary v1 event frames.
      if (call.method !== 'b3.terminal.open' && call.method !== 'b3.terminal.attach') return;
      if (events !== null) void followNewSessions(events);
    },

    onDisconnect(connectionId: number) {
      void detachConnection(connectionId);
    },

    async serve(sink: EventSink) {
      events = sink;
      broadcastEvent = (kind, payload) => { sink.broadcast('b3.agent.event', { kind, ...payload }); };
      sightings = setInterval(() => { void reportSightings(); }, SIGHTING_INTERVAL_MS);
      sightings.unref(); // a heartbeat must never be the reason a process stays up

      // Claim the machine before accepting a single command, so a second host
      // can never serve a request it is not allowed to have served.
      const ensured = await runtime.runtime.ensureLocalRuntime({
        principal: { id: principalId, kind: 'human', verifiedScopes: [] },
        clientOpId: mintClientOpId(),
        traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      });
      if (!ensured.ok) throw new Error(`${ensured.error.code}: ${ensured.error.message}`);
    },

    async close() {
      if (sightings !== null) clearInterval(sightings);
      sightings = null;
      await runtime.close();
    },
  };
}
