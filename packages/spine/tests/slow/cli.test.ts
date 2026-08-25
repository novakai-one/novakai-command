import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  mintClientOpId,
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';
import {
  createEmbeddedMessaging,
  createSystemClock,
  DEFAULT_ROLE_GRANTS,
  openJsonlStore,
  type MessagingSession,
  type PersonId,
} from '@novakai/messaging';
import { composeProjects } from '@novakai/projects';
import { composeArtifacts } from '@novakai/artifacts';
import type { SpineWorkflow } from '../../contract/index.js';

// Source lives at tests/slow/, compiled output at dist/tests/slow/ — the
// depth differs, so resolve the package root by walking up to tsconfig.json.
const packageRoot = (() => {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (!existsSync(path.join(dir, 'tsconfig.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root not found from ${dir}`);
    dir = parent;
  }
  return dir;
})();

// The CLI is the COMPILED entry point: requires `npm run build` first (slow
// tier only).
const cliPath = path.join(packageRoot, 'dist', 'cli', 'nvk-spine.js');

function invoke(
  root: string,
  bearer: string,
  args: string[],
): unknown {
  return JSON.parse(execFileSync(
    process.execPath,
    [cliPath, ...args, '--root', root, '--token', bearer],
    { encoding: 'utf8' },
  )) as unknown;
}

async function seedMessage(
  root: string,
  senderBearer: string,
): Promise<string> {
  const clock = createSystemClock();
  const store = await openJsonlStore(clock, {
    path: path.join(root, 'messaging.jsonl'),
  });
  const messaging = createEmbeddedMessaging({
    clock,
    store,
    authority: {
      principals: [
        {
          token: senderBearer,
          personId: 'person_chris' as PersonId,
          roles: ['Human'],
        },
        {
          token: 'recipient-token',
          personId: 'person_worker' as PersonId,
          roles: ['Worker'],
        },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  await messaging.start();
  try {
    const senderAuth = await messaging.authenticate({ token: senderBearer });
    const recipientAuth = await messaging.authenticate({
      token: 'recipient-token',
    });
    assert.equal(senderAuth.kind, 'authenticated');
    assert.equal(recipientAuth.kind, 'authenticated');
    if (
      senderAuth.kind !== 'authenticated'
      || recipientAuth.kind !== 'authenticated'
    ) {
      return assert.fail('messaging seed authentication failed');
    }
    const sender: MessagingSession = senderAuth.session;
    const recipient: MessagingSession = recipientAuth.session;
    const policy = await recipient.setContactPolicy({
      allowlist: ['person_chris'],
      defaultRule: 'deny',
    });
    assert.equal(policy.kind, 'ok');
    const sent = await sender.sendMessage({
      address: 'person:person_worker',
      body: { text: 'CLI Spine source' },
      priority: 'normal',
      clientMessageId: 'cli-spine-message',
    });
    if (sent.kind !== 'ok') return assert.fail(sent.error.message);
    return sent.value.messageId;
  } finally {
    await messaging.close();
  }
}

test('nvk-spine provides authenticated offline parity for workflow lifecycle operations', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-cli-'));
  const root = path.join(workspace, '.novakai');
  try {
    const token = mintToken(
      root,
      'person_chris',
      ['spine'],
      'person_admin',
    );
    const projects = composeProjects({
      root,
      principal: 'person_chris',
    });
    const project = await projects.operations.createProject(
      { title: 'CLI project' },
      mintClientOpId(),
    );
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const artifact = await composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations.putArtifact({
      bytes: Buffer.from('CLI artifact'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const messageId = await seedMessage(root, token.bearer);

    const message = invoke(root, token.bearer, [
      'add-message',
      '--message', messageId,
      '--project', project.value.id,
      '--client-op-id', 'op_cli_message',
    ]) as SpineWorkflow;
    assert.equal(message.state, 'done');

    const attached = invoke(root, token.bearer, [
      'attach-artifact',
      '--artifact', artifact.value.id,
      '--project', project.value.id,
      '--client-op-id', 'op_cli_artifact',
    ]) as SpineWorkflow;
    assert.equal(attached.state, 'done');

    const listed = invoke(
      root,
      token.bearer,
      ['workflows'],
    ) as { items: SpineWorkflow[] };
    assert.equal(listed.items.length, 2);
    const status = invoke(root, token.bearer, [
      'status',
      '--workflow', message.workflowId,
    ]) as SpineWorkflow;
    assert.equal(status.workflowId, message.workflowId);

    const interruptedContinue = spawnSync(process.execPath, [
      cliPath,
      'add-message',
      '--message', messageId,
      '--project', project.value.id,
      '--client-op-id', 'op_cli_continue_source',
      '--root', root,
      '--token', token.bearer,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NVK_FAILPOINT: 'spine.journal.accepted.after',
      },
    });
    assert.equal(interruptedContinue.status, 1);
    const resumable = invoke(
      root,
      token.bearer,
      ['workflows'],
    ) as { items: SpineWorkflow[] };
    const toContinue = resumable.items.find(
      ({ originalClientOpId }) =>
        originalClientOpId === 'op_cli_continue_source',
    );
    assert.ok(toContinue);
    const continued = invoke(root, token.bearer, [
      'continue',
      '--workflow', toContinue.workflowId,
      '--client-op-id', 'op_cli_continue',
    ]) as SpineWorkflow;
    assert.equal(continued.state, 'done');

    const interruptedAbandon = spawnSync(process.execPath, [
      cliPath,
      'attach-artifact',
      '--artifact', artifact.value.id,
      '--project', project.value.id,
      '--client-op-id', 'op_cli_abandon_source',
      '--root', root,
      '--token', token.bearer,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NVK_FAILPOINT: 'spine.journal.accepted.after',
      },
    });
    assert.equal(interruptedAbandon.status, 1);
    const beforeAbandon = invoke(
      root,
      token.bearer,
      ['workflows'],
    ) as { items: SpineWorkflow[] };
    const toAbandon = beforeAbandon.items.find(
      ({ originalClientOpId }) =>
        originalClientOpId === 'op_cli_abandon_source',
    );
    assert.ok(toAbandon);
    const abandoned = invoke(root, token.bearer, [
      'abandon',
      '--workflow', toAbandon.workflowId,
      '--client-op-id', 'op_cli_abandon',
    ]) as SpineWorkflow;
    assert.equal(abandoned.state, 'abandoned');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
