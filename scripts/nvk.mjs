#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const adapters = new Map([
  ['project', path.join(repoRoot, 'packages/projects/cli/nvk-project.ts')],
  ['artifact', path.join(repoRoot, 'packages/artifacts/cli/nvk-artifact.ts')],
  ['spine', path.join(repoRoot, 'packages/spine/cli/nvk-spine.ts')],
  // B3: the canonical families of §17.1 / DEC-B3V4-04. `nvk agent spawn` is the
  // command the onboarding promises and the one an operator actually types;
  // until now it was a usage error, and every verb had to be driven as
  // `npx tsx <absolute path to>/nvk-agent.ts`.
  ['agent', path.join(repoRoot, 'packages/server/cli/nvk-agent.ts')],
  // Flow 2: an agent spawns a child agent headlessly — no server involved.
  ['child', path.join(repoRoot, 'packages/agents/cli/nvk-child.ts')],
  ['runtime', path.join(repoRoot, 'packages/server/cli/nvk-runtime.ts')],
  ['terminal', path.join(repoRoot, 'packages/server/cli/nvk-terminal.ts')],
  // B3d §17.1: what is watching, and what it has queued.
  ['watch', path.join(repoRoot, 'packages/server/cli/nvk-watch.ts')],
]);

const [group, ...args] = process.argv.slice(2);
const adapter = adapters.get(group);
if (!adapter) {
  process.stderr.write(`${JSON.stringify({
    code: 'Usage',
    message: `usage: nvk ${[...adapters.keys()].join('|')} <verb> [options]`,
  })}\n`);
  process.exitCode = 2;
} else {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const child = spawnSync(
    process.execPath,
    [tsxCli, adapter, ...args],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (child.error) {
    process.stderr.write(`${JSON.stringify({
      code: 'CliUnavailable',
      message: child.error.message,
    })}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = child.status ?? 1;
  }
}
