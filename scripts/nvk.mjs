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
  ['transcript', path.join(repoRoot, 'packages/transcript/cli/nvk-transcript.ts')],
]);

const [group, ...args] = process.argv.slice(2);
const adapter = adapters.get(group);
if (!adapter) {
  process.stderr.write(`${JSON.stringify({
    code: 'Usage',
    message: 'usage: nvk project|artifact|spine|transcript <verb> [options]',
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
