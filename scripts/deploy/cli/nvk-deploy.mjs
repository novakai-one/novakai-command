#!/usr/bin/env node
// deploy/cli/nvk-deploy.mjs — thin entry: argv → one contract/api call.
//
//   nvk deploy                 build, snapshot this checkout, swap the live server to it
//   nvk deploy status          what is running vs what the checkout has
//   nvk deploy --scratch       prove the pipeline on a throwaway port; live server untouched
//   nvk deploy --scratch --hold  …and keep the scratch server up for inspection
//   nvk deploy --dry-run       print the plan, change nothing
//   nvk deploy --keep <n>      releases to retain (default 5)
//   nvk deploy --allow-dirty   deploy uncommitted changes (refused by default)
//
// The live server (launchd job com.novakai.prod, port 5180) never runs the
// working checkout. It runs a frozen clone stamped with its commit
// (release.json → /version). Agents can merge all day; the running app moves
// only when this command says so — and rolls back if the candidate is unwell.
import { DeployError, deploy, dryRun, scratch, status } from '../contract/index.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Run the requested verb; DeployError prints as a refusal, not a stack. */
async function main() {
  const options = {
    keep: Number(valueOf('--keep') ?? 5),
    allowDirty: has('--allow-dirty'),
  };
  if (args[0] === 'status') return status();
  if (has('--dry-run')) return dryRun(options);
  if (has('--scratch')) return scratch({ hold: has('--hold') });
  return deploy(options);
}

try {
  await main();
} catch (cause) {
  if (cause instanceof DeployError) {
    process.stderr.write(`\n[nvk deploy] FAILED: ${cause.message}\n`);
    process.exit(1);
  }
  throw cause;
}
