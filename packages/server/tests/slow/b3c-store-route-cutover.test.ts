// §18.1 steps 1–7, for the WHOLE store — not just Messaging's own journal.
//
// The shipped gate migrates one file: the custom `store-jsonl` Messaging
// journal. §18.1 is broader than that. "Older B1 Foundation files inside the
// `.novakai/` root ... are migration sources", and step 4 says: for EACH
// registered kind whose canonical target file is absent and legacy file exists,
// Foundation copies the complete legacy file to the target. A root upgraded
// from B1 therefore has ~40 legacy files sitting beside the new `stores/`
// directory, and the shipped boot copies none of them — Foundation's dual-read
// shim copies a kind lazily on its FIRST WRITE, which is the "new-root-first
// fallback ... silently hiding a newer legacy append" that §18.1's last
// paragraph forbids by name.
//
// The legacy root here is not hand-authored. It is produced by running a real
// Runtime and then flattening its `stores/` directory into the root — exactly
// the shape a B1 install has — so nothing in the fixture can be more correct
// than the product that wrote it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

const roots: string[] = [];

function scratch(prefix: string): string {
  const made = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(made);
  return made;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Legacy {
  /** A `.novakai/` root holding B1-style flat kind files and no `stores/`. */
  readonly root: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly files: readonly string[];
}

/**
 * A B1-shaped root: every kind file the product writes, sitting flat in
 * `.novakai/` with no `stores/` directory — produced by a real Runtime and then
 * flattened, so the lines are the product's own.
 */
async function seedLegacyRoot(): Promise<Legacy> {
  const producing = scratch('nvk-b3c-legacy-src-');
  const host = await startRuntimeHost({
    root: producing, port: 0, ptyHost: createFakePtyHost(),
    providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root: producing, port: host.port, token: host.token });

  const role = await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole('legacy-role'),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: 'Legacy', workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error('spawn failed');
  const agentId = spawned.value.agent.agentId;

  const thread = await chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
    between: [
      { kind: 'human', personId: 'person_chris' },
      { kind: 'agent', agentId },
    ],
  });
  assert.equal(thread.ok, true);
  if (!thread.ok) throw new Error('ensureDirectThread failed');
  const sent = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
    target: { kind: 'agent', agentId },
    threadId: thread.value.id, text: 'written before the cutover',
    clientMessageId: 'cmid-pre-cutover',
  });
  assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
  if (!sent.ok) throw new Error('sendAgent failed');

  chris.close();
  await host.close();

  // Flatten: `<producing>/stores/X.jsonl` becomes `<legacy>/X.jsonl`, which is
  // where B1 put them.
  const legacyRoot = scratch('nvk-b3c-legacy-');
  const files = readdirSync(path.join(producing, 'stores'))
    .filter((name) => name.endsWith('.jsonl'));
  for (const name of files) {
    copyFileSync(path.join(producing, 'stores', name), path.join(legacyRoot, name));
  }
  // The tokens directory is Foundation's documented special case and travels
  // with the root, not as a kind file.
  const tokens = path.join(producing, 'tokens');
  if (existsSync(tokens)) {
    mkdirSync(path.join(legacyRoot, 'tokens'), { recursive: true });
    for (const name of readdirSync(tokens)) {
      copyFileSync(path.join(tokens, name), path.join(legacyRoot, 'tokens', name));
    }
  }
  assert.equal(files.length > 5, true, `only ${String(files.length)} legacy kind files were produced`);
  return { root: legacyRoot, agentId, messageId: sent.value.messageId, files };
}

test('boot against a B1 root copies every legacy kind file into stores/ and seals a receipt', async () => {
  const legacy = await seedLegacyRoot();
  const before = new Map(legacy.files.map(
    (name) => [name, readFileSync(path.join(legacy.root, name))] as const,
  ));

  const host = await startRuntimeHost({
    root: legacy.root, port: 0, ptyHost: createFakePtyHost(),
    providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({
    root: legacy.root, port: host.port, token: host.token,
  });
  try {
    const stores = path.join(legacy.root, 'stores');

    // §18.1 step 4 — each legacy kind file is COPIED, completely. A file the
    // Runtime appends to while booting (its trace journal, its epoch) is longer
    // afterwards, never different at the front: the copy has to be the prefix.
    const missing: string[] = [];
    const diverged: string[] = [];
    for (const [name, contents] of before) {
      const target = path.join(stores, name);
      if (!existsSync(target)) { missing.push(name); continue; }
      const written = readFileSync(target);
      if (!written.subarray(0, contents.length).equals(contents)) diverged.push(name);
    }
    assert.deepEqual(missing, [],
      `legacy kind files never reached the canonical route: ${missing.join(', ')}`);
    assert.deepEqual(diverged, [],
      `canonical files do not begin with the legacy bytes they migrated: ${diverged.join(', ')}`);

    // §18.1 step 2 — the source is read-only evidence, unchanged.
    for (const [name, contents] of before) {
      assert.equal(readFileSync(path.join(legacy.root, name)).equals(contents), true,
        `the cutover modified the legacy source ${name}`);
    }

    // §18.1 step 6 — a receipt, in the file §18.1 names.
    const receipts = path.join(stores, 'storeRouteCutovers.jsonl');
    assert.equal(existsSync(receipts), true,
      'no storeRouteCutovers.jsonl: the cutover ran without sealing a receipt');
    const lines = readFileSync(receipts, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length > 0, true, 'storeRouteCutovers.jsonl is empty');
    // §18.1 step 7 — dispatch is only allowed once the receipt reconciles
    // trace-complete, so a receipt that never got there is not a seal.
    const sealed = lines.map((line) => JSON.parse(line) as { payload: { traceComplete?: boolean } })
      .some((record) => record.payload.traceComplete === true);
    assert.equal(sealed, true, 'no cutover receipt reconciled trace-complete');

    // §18.1's point — a Message committed before the cutover is readable
    // through the canonical route afterwards, by a client that knows nothing
    // about either route.
    const seen = await chris.call<{ items: readonly { messageId: string }[] }>(
      'b3.messaging.listAgentCommunications', { agentIds: [legacy.agentId] },
    );
    assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
    if (!seen.ok) return;
    assert.equal(seen.value.items.some((item) => item.messageId === legacy.messageId), true,
      'the pre-cutover Message is not readable through the canonical route');
  } finally {
    chris.close();
    await host.close();
  }
});

test('canonical and legacy both present with no receipt blocks boot and writes neither', async () => {
  const legacy = await seedLegacyRoot();
  const stores = path.join(legacy.root, 'stores');
  mkdirSync(stores, { recursive: true });
  // A canonical file beside the legacy one, with no receipt: the two-writers
  // case. Foundation's new-root-first fallback would read this one and never
  // mention the legacy file that may hold newer truth.
  const canonical = path.join(stores, 'agents.jsonl');
  copyFileSync(path.join(legacy.root, 'agents.jsonl'), canonical);

  const canonicalBefore = readFileSync(canonical);
  const legacyBefore = readFileSync(path.join(legacy.root, 'agents.jsonl'));

  let blocked: unknown = null;
  try {
    const host = await startRuntimeHost({
      root: legacy.root, port: 0, ptyHost: createFakePtyHost(),
      providers: createFakeProviderAdapters(),
    });
    await host.close();
  } catch (cause) {
    blocked = cause;
  }
  assert.notEqual(blocked, null,
    'the Runtime booted with a canonical and a legacy store present and no cutover receipt');
  assert.equal(String(blocked).includes('StoreRouteConflict'), true,
    `boot was blocked, but not with a typed StoreRouteConflict: ${String(blocked)}`);

  assert.equal(readFileSync(canonical).equals(canonicalBefore), true,
    'the blocked boot wrote to the canonical file');
  assert.equal(readFileSync(path.join(legacy.root, 'agents.jsonl')).equals(legacyBefore), true,
    'the blocked boot wrote to the legacy file');
  assert.equal(existsSync(path.join(stores, 'storeRouteCutovers.jsonl')), false,
    'the blocked boot sealed a receipt anyway');
  void writeFileSync;
});
