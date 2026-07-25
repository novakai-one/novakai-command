/**
 * spawned-server — test tooling for the process-level S1-d proofs (W2/P2/P3).
 * Spawns the standalone server as a REAL child process
 * (dist/protocol/standalone-server.js) with a store-jsonl data path in a
 * fresh temp directory, and parses its stdout protocol (SWEEP / READY /
 * FATAL). Identity provisioning is by authority config (DEC-07 mapping in
 * config, never core): the helper writes an inline authority config into the
 * server config file — tokens are the credentials external principals
 * authenticate with.
 *
 * kill("SIGKILL") is the crash case: no graceful shutdown, whatever the
 * journal holds on disk is the whole truth the next process recovers from.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityConfig } from "../../public/index.js";

/** The DEC-21 sweep report shape (core/recoverySweep) as JSON on stdout. */
export interface SweepReport {
  found: number;
  settled: number;
  failures: { messageId: string; error: { name: string; message: string } }[];
}

// dist/tests/standalone/ -> package root is three levels up.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_ENTRY = join(packageRoot, "dist", "protocol", "standalone-server.js");

export interface SpawnedServer {
  readonly port: number;
  /** The DEC-21 startup sweep report (emitted before accepting connections). */
  readonly sweep: SweepReport;
  /** The journal path the server is writing (store-jsonl). */
  readonly dataPath: string;
  readonly dataDir: string;
  readonly process: ChildProcess;
  /** Hard kill — no graceful shutdown (the W2 crash case). */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Graceful stop + temp-dir cleanup. */
  stop(): Promise<void>;
}

export interface SpawnOptions {
  /** Principal provisioning (tokens → Person IDs → roles/grants). */
  authority: AuthorityConfig;
  /** Extra standalone options (effectDeadlineMs, busPollIntervalMs, …). */
  serverOptions?: Record<string, unknown>;
  /** Reuse an existing data directory (restart on the same journal). */
  dataDir?: string;
}

export async function spawnStandaloneServer(options: SpawnOptions): Promise<SpawnedServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "messaging-s1d-"));
  const dataPath = join(dataDir, "messaging.jsonl");
  const configPath = join(dataDir, "server-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataPath,
      port: 0,
      authority: options.authority,
      ...(options.serverOptions ?? {}),
    }),
  );

  const child = spawn(process.execPath, [SERVER_ENTRY, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  function findLine(prefix: string): string | undefined {
    return stdout
      .split("\n")
      .find((line) => line.startsWith(`${prefix} `))
      ?.slice(prefix.length + 1);
  }

  async function waitForLine(prefix: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = findLine(prefix);
      if (found !== undefined) return found;
      const fatal = findLine("FATAL");
      if (fatal !== undefined) {
        throw new Error(`standalone server failed to start: ${fatal}\n${stderr}`);
      }
      if (child.exitCode !== null) {
        throw new Error(
          `standalone server exited ${child.exitCode} before ${prefix}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${prefix}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const sweepLine = await waitForLine("SWEEP");
  const readyLine = await waitForLine("READY");

  const server: SpawnedServer = {
    port: Number.parseInt(readyLine, 10),
    sweep: JSON.parse(sweepLine) as SweepReport,
    dataPath,
    dataDir,
    process: child,

    async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill(signal);
      await exited;
    },

    async stop(): Promise<void> {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        await Promise.race([exited, timeout]);
        if (child.exitCode === null) await server.kill("SIGKILL");
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return server;
}
