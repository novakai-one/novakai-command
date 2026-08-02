// Whose environment starts a managed PTY — §14, DEC-B3V4-23.
//
// The adapter assembles a COMPLETE environment for a provider launch: it starts
// from the host's and adds what the spawned Agent needs to authenticate as
// itself (DEC-B3V4-05). The node PTY host then merged the host's environment
// UNDERNEATH it again — which is invisible until an adapter needs a variable to
// be ABSENT. Then it is not: absence in a patch means "inherit", so the
// variable comes straight back.
//
// This is exactly how the exam's claude leg kept reporting "Transcript saving
// is off — inherited CLAUDE_CODE_CHILD_SESSION marker" after the adapter had
// removed that marker: the adapter removed it, and the launcher put it back.
//
// The rule this pins: an authority that supplies an environment supplies the
// WHOLE environment. One that does not — the plain shell, the mock session —
// inherits the host's, which is what those two want.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodePtyHost } from '../../adapters/pty-host/node-pty.js';
import type { LaunchAuthorityRegistrar } from '../../adapters/pty-host/node-pty.js';
import { createLaunchAuthorities } from '../../adapters/pty-host/node-pty.js';

const HOST_ONLY = 'NVK_TEST_HOST_ONLY_MARKER';

/** Read the child's own environment back out of the PTY. */
async function environmentOfLaunch(
  register: (authorities: LaunchAuthorityRegistrar) => string,
  hostEnvironment: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const authorities = createLaunchAuthorities(hostEnvironment);
  const authorityRef = register(authorities);
  const host = await createNodePtyHost({ authorities, environment: hostEnvironment });
  const started = await host.start({
    workingDirectory: process.cwd(),
    columns: 80, rows: 24,
    launchAuthorityRef: authorityRef,
  });
  assert.equal(started.ok, true,
    started.ok ? '' : `${started.error.code}: ${started.error.message}`);
  if (!started.ok) throw new Error('pty did not start');

  let output = '';
  started.value.onData((chunk) => { output += chunk.toString('utf8'); });
  await new Promise<void>((resolve) => { started.value.onExit(() => { resolve(); }); });
  started.value.kill();

  const environment: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1).trim();
  }
  return environment;
}

test('an authority that supplies an environment supplies the whole environment', async () => {
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...process.env, [HOST_ONLY]: 'inherited-from-the-host',
  };
  // What a provider adapter builds: the host's environment MINUS one variable
  // it has decided a managed Run must not carry, plus its own.
  const adapterEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnvironment)) {
    if (typeof value === 'string') adapterEnvironment[name] = value;
  }
  delete adapterEnvironment[HOST_ONLY];
  adapterEnvironment['NVK_AGENT_RUN_ID'] = 'agentRun_env_test';

  const seen = await environmentOfLaunch((authorities) => {
    authorities.register('env-probe', {
      file: '/bin/sh', args: ['-c', 'env'], environment: adapterEnvironment,
    });
    return 'env-probe';
  }, hostEnvironment);

  assert.equal(seen['NVK_AGENT_RUN_ID'], 'agentRun_env_test',
    'the adapter environment did not reach the child at all');
  assert.equal(HOST_ONLY in seen, false,
    'the launcher merged the host environment back under the adapter\'s, so a '
    + 'variable the adapter deliberately removed reached the managed Run anyway');
});

test('an authority with no environment still inherits the host\'s', async () => {
  // The plain shell and the mock managed session carry no environment and must
  // keep working exactly as they did.
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...process.env, [HOST_ONLY]: 'inherited-from-the-host',
  };
  const seen = await environmentOfLaunch((authorities) => {
    authorities.register('bare-probe', { file: '/bin/sh', args: ['-c', 'env'] });
    return 'bare-probe';
  }, hostEnvironment);

  assert.equal(seen[HOST_ONLY], 'inherited-from-the-host',
    'an authority with no environment of its own stopped inheriting the host\'s');
});
