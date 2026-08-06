// The background Runtime host process (§17 tree: server/adapters/runtime-host).
//
// It is deliberately independent of the desktop shell: closing Novakai closes a
// controller, not this. Everything it exposes rides the existing nvk-ws v1
// transport, so an external terminal and the app are the same kind of client.
//
// What it is, since A4: one of TWO roots that mount the same `b3.*` adapter
// (`runtime-wire.ts`). This one serves the Runtime alone; `boot.ts` serves it
// beside the Shell's own methods on one port. Neither owns the method table, so
// the headless host and the backed Shell cannot be handed different surfaces.
import { startTransport, type RunningTransport } from '../transport/server.js';
import { composeB3Wire, type B3WireOptions } from './runtime-wire.js';
import type { B3Runtime } from './composition.js';

export interface RuntimeHostProcessOptions extends B3WireOptions {
  readonly port: number;
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
  const wire = await composeB3Wire(options);

  const transport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    methods: wire.methods,
    identifyCaller: wire.identifyCaller,
    onDispatch: wire.onDispatch,
    onDisconnect: wire.onDisconnect,
  });

  try {
    await wire.serve(transport);
  } catch (cause) {
    // The claim was refused, so this process never becomes the runtime: it
    // gives the port back rather than sitting on it half-composed.
    await transport.close();
    await wire.close();
    throw cause;
  }

  return {
    httpUrl: transport.url,
    port: transport.port,
    token: transport.token,
    runtime: wire.runtime,
    transport,
    async close() {
      await transport.close();
      await wire.close();
    },
  };
}
