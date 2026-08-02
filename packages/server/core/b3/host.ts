// The background Runtime host process (§17 tree: server/adapters/runtime-host).
//
// It is deliberately independent of the desktop shell: closing Novakai closes a
// controller, not this. Everything it exposes rides the existing nvk-ws v1
// transport, so an external terminal and the app are the same kind of client.
import {
  agentRunPrincipalId, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type B3Result,
  type ControllerAttachmentId, type HumanPrincipalId, type SystemCommandContext,
  type TerminalSessionId,
} from '@novakai/foundation/contract';
import { HUMAN_SCOPES } from '../../../agents/b3/contract/index.js';
import { DEFAULT_STALE_AFTER_MS } from '../../../terminal/contract/index.js';
import { startTransport, type DispatchedCall, type RunningTransport } from '../transport/server.js';
import type { CallerIdentity, CallerSession } from '../../contract/protocol.js';
import { composeB3Runtime, type B3Runtime, type B3RuntimeOptions } from './composition.js';
import { buildB3Methods } from './methods.js';
import { buildB3AgentMethods } from './agent-methods.js';
import { buildB3MessagingMethods } from './messaging-methods.js';

/** Comfortably inside the stale window, so a live window is never called gone. */
const SIGHTING_INTERVAL_MS = Math.floor(DEFAULT_STALE_AFTER_MS / 3);

interface OpenedController {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
}

/** The attach/detach result as it comes back off the method table. */
function attachmentIn(result: unknown): OpenedController | null {
  const outcome = result as B3Result<OpenedController & { id?: ControllerAttachmentId }>;
  if (!outcome?.ok) return null;
  const attachmentId = outcome.value.id ?? outcome.value.attachmentId;
  if (attachmentId === undefined || outcome.value.terminalSessionId === undefined) return null;
  return { attachmentId, terminalSessionId: outcome.value.terminalSessionId };
}

export interface RuntimeHostProcessOptions extends B3RuntimeOptions {
  readonly port: number;
  readonly principalId?: HumanPrincipalId;
  /** Bundle directory, when this host also serves the shell. */
  readonly staticDir?: string;
  /**
   * The runtime has been stopped through its own contract. A serving daemon
   * uses this to release the port; an in-process host may ignore it.
   */
  readonly onRuntimeStopped?: () => void;
}

export interface RunningRuntimeHost {
  readonly httpUrl: string;
  readonly port: number;
  readonly token: string;
  readonly runtime: B3Runtime;
  readonly transport: RunningTransport;
  close(): Promise<void>;
}

export async function startRuntimeHost(
  options: RuntimeHostProcessOptions,
): Promise<RunningRuntimeHost> {
  // Live events leave as ordinary v1 event frames, exactly as terminal output
  // does. Composition is where that is decided: the capability publishes, and
  // the HOST chooses who hears it (§12.6 — server transports, it owns no state).
  let broadcastEvent: (kind: string, payload: Readonly<Record<string, unknown>>) => void
    = () => undefined;
  const runtime = await composeB3Runtime({
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
    ...buildB3Methods({
      runtime, principalId,
      // Announced, not acted on here: whether a stopped runtime should exit its
      // process is the HOST's decision (a serving daemon exits; an in-process
      // test host does not), so `startRuntimeHost` only forwards the fact.
      onRuntimeStopped: () => { options.onRuntimeStopped?.(); },
    }),
    ...buildB3AgentMethods({
      runtime,
      principalFor,
      contextFor: (principal, _session, clientOpId) => ({
        principal,
        clientOpId,
        traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      }),
    }),
    ...buildB3MessagingMethods({
      messaging: runtime.messaging,
      transcript: runtime.transcript,
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
      contextFor: (principal, _session, clientOpId) => ({
        principal,
        clientOpId,
        traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      }),
    }),
  };
  const following = new Set<string>();
  /** Which windows each connection opened — the host's own fact (§13.4). */
  const controllersByConnection = new Map<number, Map<string, OpenedController>>();

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

  const transport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    methods,
    identifyCaller,
    onDispatch(call: DispatchedCall) {
      if (call.method === 'b3.terminal.attach' || call.method === 'b3.terminal.detach') {
        remember(call);
      }
      // A controller that opened or attached wants to SEE the session, so the
      // host starts pushing its output as ordinary v1 event frames.
      if (call.method !== 'b3.terminal.open' && call.method !== 'b3.terminal.attach') return;
      void followNewSessions();
    },
    onDisconnect(connectionId: number) {
      void detachConnection(connectionId);
    },
  });

  broadcastEvent = (kind, payload) => {
    transport.broadcast('b3.agent.event', { kind, ...payload });
  };

  const sightings = setInterval(() => { void reportSightings(); }, SIGHTING_INTERVAL_MS);
  sightings.unref(); // a heartbeat must never be the reason a process stays up

  /** Push one session's live output until it ends. Idempotent per session. */
  function follow(terminalSessionId: string): void {
    if (following.has(terminalSessionId)) return;
    following.add(terminalSessionId);
    void (async () => {
      for await (const frame of runtime.terminal.readTerminalStream(
        { id: principalId, kind: 'human', verifiedScopes: [] },
        { terminalSessionId: terminalSessionId as never },
      )) {
        if (!frame.ok) break;
        transport.broadcast('b3.terminal.output', { terminalSessionId, frame: frame.value });
        if (frame.value.kind === 'exit') break;
      }
      following.delete(terminalSessionId);
    })();
  }

  async function followNewSessions(): Promise<void> {
    const listed = await runtime.terminal.listTerminalSessions(
      { id: principalId, kind: 'human', verifiedScopes: [] }, { state: 'live' },
    );
    if (!listed.ok) return;
    for (const view of listed.value) follow(view.session.id);
  }

  // Claim the machine before accepting a single command, so a second host can
  // never serve a request it is not allowed to have served.
  const ensured = await runtime.runtime.ensureLocalRuntime({
    principal: { id: principalId, kind: 'human', verifiedScopes: [] },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });
  if (!ensured.ok) {
    await transport.close();
    await runtime.close();
    throw new Error(`${ensured.error.code}: ${ensured.error.message}`);
  }

  // Live terminal output leaves as an ordinary v1 event frame.
  return {
    httpUrl: transport.url,
    port: transport.port,
    token: transport.token,
    runtime,
    transport,
    async close() {
      clearInterval(sightings);
      await transport.close();
      await runtime.close();
    },
  };
}
