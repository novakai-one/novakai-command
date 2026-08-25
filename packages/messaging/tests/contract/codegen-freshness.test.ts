/**
 * Codegen freshness guard (law #3): contract/types.ts must be
 * byte-identical to a fresh generation from contract/messaging-contract.json.
 *
 * Chosen mechanism: run the generator in --check mode (regenerate to a string,
 * diff against the checked-in file, exit 1 on drift). After editing the
 * contract source, run `npm run generate` to refresh.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/tests/contract/ -> package root is three levels up; from TS source
// (tests/contract/) it is two. The contract JSON is source-only (tsc does
// not copy it to dist), so it marks which layout we are running from.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = existsSync(join(here, "..", "..", "contract", "messaging-contract.json"))
  ? join(here, "..", "..")
  : join(here, "..", "..", "..");

test("generated.ts is up to date with contract/messaging-contract.json", () => {
  execFileSync(process.execPath, [join(packageRoot, "tools", "generate-ts.mjs"), "--check"], {
    encoding: "utf8",
  });
});
