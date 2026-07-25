/**
 * protocol/standalone-server — the spawnable standalone-mode entrypoint
 * (Plan §17 `protocol/ws-server`, DEC-17). A thin process shell around the
 * standalone composition root: zero business logic, all behaviour lives in
 * composition/standalone.ts. Exists so external hosts and the process-level
 * proofs (S1-d: W2 crash-retry, P2, P3) can run the capability as a real
 * child process against a real store-jsonl data path.
 *
 * Usage:
 *   node dist/protocol/standalone-server.js --config <path-to-config.json>
 *
 * Config file: JSON matching StandaloneMessagingOptions minus `clock`
 * (a process always runs the system clock), e.g.
 *   {
 *     "dataPath": "/var/lib/messaging/messaging.jsonl",
 *     "port": 8787,                       // 0 = ephemeral
 *     "authorityConfigPath": "/etc/messaging/authority.json"
 *     // …or inline "authority": { principals, roleGrants }
 *   }
 *
 * Stdout protocol (line-oriented, for the spawning process):
 *   SWEEP <json>   — the DEC-21 startup recovery-sweep report (runs BEFORE
 *                    the server accepts connections: accept-after-sweep).
 *   READY <port>   — listening; the resolved port (port 0 → ephemeral).
 *   FATAL <json>   — startup failed; the process exits non-zero.
 *
 * Shutdown: SIGTERM closes gracefully; SIGKILL is the crash case the W2
 * proof exercises — the journal on disk is the only state that survives.
 */

import { readFileSync } from "node:fs";
import { createStandaloneMessaging } from "../composition/standalone.js";
import type { StandaloneMessagingOptions } from "../composition/standalone.js";

/** The config file shape: the standalone options, minus the in-process clock. */
export type StandaloneServerConfig = Omit<StandaloneMessagingOptions, "clock">;

function readConfigPath(argv: string[]): string {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value === "") {
    process.stderr.write("usage: standalone-server --config <path-to-config.json>\n");
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const configPath = readConfigPath(process.argv.slice(2));
  const config = JSON.parse(readFileSync(configPath, "utf8")) as StandaloneServerConfig;

  const server = await createStandaloneMessaging(config);

  process.stdout.write(`SWEEP ${JSON.stringify(server.sweep)}\n`);
  process.stdout.write(`READY ${server.port}\n`);

  process.on("SIGTERM", () => {
    // F2: a hung graceful close must not hang the process forever — force an
    // exit if close() has not completed within the guard window. The timer is
    // unref'd: a prompt close() exits normally via process.exit(0) below.
    const guard = setTimeout(() => {
      process.stderr.write("SIGTERM: graceful close exceeded 5s — forcing exit\n");
      process.exit(1);
    }, 5_000);
    guard.unref();
    void server.close().then(() => {
      clearTimeout(guard);
      process.exit(0);
    });
  });
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stdout.write(`FATAL ${JSON.stringify({ message })}\n`);
  process.exit(1);
});
