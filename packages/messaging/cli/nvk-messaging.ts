#!/usr/bin/env node
/** Thin standalone Messaging process entry. */

import { runStandaloneServer } from "../adapters/standalone/server.js";

runStandaloneServer(process.argv.slice(2)).catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stdout.write(`FATAL ${JSON.stringify({ message })}\n`);
  process.exit(1);
});
