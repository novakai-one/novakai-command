// The background Runtime host process (§17 tree: server/adapters/runtime-host).
//
// It is deliberately independent of the desktop shell: closing Novakai closes a
// controller, not this. Everything it exposes rides the existing nvk-ws v1
// transport, so an external terminal and the app are the same kind of client.
import { mintClientOpId, mintTraceCorrelationId, type HumanPrincipalId } from '@novakai/foundation/contract';
import { startTransport, type RunningTransport } from '../transport/server.js';
import { composeB3Runtime, type B3Runtime, type B3RuntimeOptions } from './composition.js';
import { buildB3Methods } from './methods.js';

export interface RuntimeHostProcessOptions extends B3RuntimeOptions {
  readonly port: number;
  readonly principalId?: HumanPrincipalId;
  /** Bundle directory, when this host also serves the shell. */
  readonly staticDir?: string;
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
  const runtime = await composeB3Runtime(options);
  const principalId = options.principalId ?? ('person_chris' as HumanPrincipalId);

  const transport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    methods: buildB3Methods({ runtime, principalId }),
  });

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
      await transport.close();
      await runtime.close();
    },
  };
}
