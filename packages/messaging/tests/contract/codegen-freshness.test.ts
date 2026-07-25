/**
 * Codegen freshness guard (law #3): public/contract/generated.ts must be
 * byte-identical to a fresh generation from contract/messaging-contract.json.
 *
 * Chosen mechanism: run the generator in --check mode (regenerate to a string,
 * diff against the checked-in file, exit 1 on drift). After editing the
 * contract source, run `npm run generate` to refresh.
 */

import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/tests/contract/ -> package root is three levels up.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("generated.ts is up to date with contract/messaging-contract.json", () => {
  execFileSync(process.execPath, [join(packageRoot, "tools", "generate-ts.mjs"), "--check"], {
    encoding: "utf8",
  });
});
