/**
 * F2 — graceful shutdown must not deadlock with live clients.
 *
 * The pre-fix close order awaited ws's server.close() callback BEFORE closing
 * sockets; that callback never fires while clients are connected, so close()
 * hung forever and transport.closeAll() was unreachable. Proven at both
 * levels:
 *   1. in-process: a live SUBSCRIBED client is connected; handle.close()
 *      resolves promptly and the client's socket is closed.
 *   2. process level: SIGTERM to the spawned standalone server with a live
 *      subscribed client attached exits 0 promptly (no SIGKILL needed).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStandaloneMessaging, DEFAULT_ROLE_GRANTS } from "../../public/index.js";
import type { AuthorityConfig } from "../../public/index.js";
import { ExternalChief } from "./external-chief.js";
import { spawnStandaloneServer } from "./spawned-server.js";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-chief", personId: "person_chief" as never, roles: ["Chief"] },
    { token: "tok-worker", personId: "person_worker" as never, roles: ["Worker"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

describe("F2 — graceful shutdown with live clients", () => {
  it("close() returns promptly with a live subscribed client connected", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "messaging-f2-"));
    const handle = await createStandaloneMessaging({
      dataPath: join(dataDir, "messaging.jsonl"),
      port: 0,
      authority: AUTHORITY,
    });
    try {
      const chief = await ExternalChief.connect(handle.port);
      const auth = await chief.authenticate("tok-chief");
      assert.ok(auth.ok);
      await chief.openPresence();
      await chief.subscribe(["MessageCommitted", "PresenceChanged"]);

      // F2: pre-fix this never resolved — the ws close callback never fires
      // with a connected client. Race close() against a hard timeout so a
      // regression fails the test instead of hanging the suite.
      const started = Date.now();
      await Promise.race([
        handle.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("F2: close() deadlocked with a live client")), 3_000),
        ),
      ]);
      assert.ok(Date.now() - started < 3_000, "close() resolved promptly");
      await chief.close().catch(() => undefined); // socket already closed by the server
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("SIGTERM with a live subscribed client exits 0 promptly (no SIGKILL)", async () => {
    const server = await spawnStandaloneServer({ authority: AUTHORITY });
    try {
      const chief = await ExternalChief.connect(server.port);
      const auth = await chief.authenticate("tok-chief");
      assert.ok(auth.ok);
      await chief.openPresence();
      await chief.subscribe(["MessageCommitted"]);

      const exited = new Promise<number | null>((resolve) =>
        server.process.once("exit", (code) => resolve(code)),
      );
      server.process.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
      ]);
      assert.equal(code, 0, "F2: SIGTERM closes gracefully even with live clients");
      await chief.close().catch(() => undefined);
    } finally {
      await server.stop();
    }
  });
});
