// B3c — the `.novakai` owner/path inventory (§3.4, §18.1, §25-B3c, red gate 32).
//
// "Every new/changed Novakai JSONL record is written below the configured,
// gitignored `.novakai` root", and "no Message, Thread, Delivery, acceptance,
// endpoint or inbox JSONL file exists outside messagingStoreOps.jsonl".
//
// Both are claims about the FILESYSTEM, and the only honest way to check a
// claim about the filesystem is to look at it. So this drives a real Runtime
// through the whole B3c surface — threads, sends, endpoint transfer, transcript
// binding, mirror, subagents — and then walks the directory it wrote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

/** A Run id no spawn ever minted — a SECOND binding, on purpose (see below). */
const UNMANAGED_RUN = 'agentRun_01900000-0000-7000-8000-000000000001';

const human = {
  principal: { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000001' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000001' as never,
  contractVersion: 1 as const,
};
const runtimeCtx = {
  principal: { id: 'sys_agent_runtime' as never, kind: 'system' as const, verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000002' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000002' as never,
  contractVersion: 1 as const,
};

/** Every JSONL file below a root, relative to it. */
function jsonlFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.jsonl')) found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * A real Agent, spawned through the published wire.
 *
 * These were two hardcoded ids that had never been created, which passed only
 * while `sendAgentMessage` accepted a Message for an Agent nobody had spawned
 * (the hole P0-5 closed). An inventory test is a claim about the files a REAL
 * run writes, so it has to be a real run.
 */
async function spawnAgent(
  client: RuntimeClient, name: string,
): Promise<{ agentId: string; agentRunId: string }> {
  const role = await client.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole(`${name}-role`),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true, role.ok ? '' : role.error.message);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await client.call<{
    agent: { agentId: string }; run: { id: string };
  }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
  return { agentId: spawned.value.agent.agentId, agentRunId: spawned.value.run.id };
}

test('every B3c record lands under .novakai/stores, and Messaging owns exactly one file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-inventory-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const { messaging, transcript } = host.runtime;
    const continueClient = await connectRuntime({
      root, port: host.port, token: host.token,
    });
    const first = await spawnAgent(continueClient, 'Inventory');
    const AGENT = first.agentId;
    const agentRunId = first.agentRunId;
    const OTHER = (await spawnAgent(continueClient, 'InventoryOther')).agentId;

    // Exercise the whole B3c surface, so anything that would write a file has
    // a chance to. A test that writes nothing proves nothing.
    const thread = await messaging.ensureDirectThread(human, {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: AGENT as never },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    const group = await messaging.ensureGroupThread(human, {
      participants: [
        { kind: 'agent', agentId: AGENT as never },
        { kind: 'agent', agentId: OTHER as never },
      ],
    });
    assert.equal(group.ok, true);

    // The endpoint claim is NOT reserved by hand any more. The spawn above
    // already performed §13.5 rows 6/9/10 for real, so a hand-driven
    // `expectedEndpointGeneration: -1` now describes a state the product has
    // already moved past — and a test that reserves its own claim is
    // performing the very lifecycle it is supposed to be inspecting the files
    // of (P1-13's rule, pointed at a test).
    for (const text of ['one', 'two']) {
      const sent = await messaging.sendAgentMessage(human, {
        target: { kind: 'agent', agentId: AGENT as never },
        threadId: thread.value.id, text, clientMessageId: `cmid-${text}`,
      });
      assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    }

    // The endpoint transfer comes from the real continuation, which drains,
    // finalises the watermark and transfers — the §13.6 ladder rather than a
    // hand-made version of it.
    const continued = await continueClient.call<{ run: { id: string } }>('b3.agent.continue', {
      agentId: AGENT, expectedOldRunId: agentRunId,
      mode: 'fresh', configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true,
      continued.ok ? '' : `${continued.error.code}: ${continued.error.message}`);

    await messaging.openConversationView(human, {
      threadId: group.ok ? group.value.id : thread.value.id,
      membership: { kind: 'group', agentIds: [AGENT as never, OTHER as never] },
    });

    const bound = await transcript.bindTranscriptToRun(runtimeCtx, {
      agentId: AGENT as never, agentRunId: UNMANAGED_RUN as never, provider: 'claude',
      providerSessionId: 'sess_11111111-0000-4000-8000-000000000001' as never,
      threadId: thread.value.id,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    await transcript.ingestTranscriptSource({
      ...runtimeCtx,
      principal: { id: 'sys_transcript' as never, kind: 'system', verifiedScopes: [] },
    }, { bindingId: bound.value.id, maxLines: 50 });

    continueClient.close();
    await host.close();

    // ── the inventory ────────────────────────────────────────────────────
    const files = jsonlFiles(root);
    for (const file of files) {
      assert.equal(file.startsWith('stores/'), true,
        `${file} is a Novakai JSONL record outside the configured dataRoot`);
    }

    // §18.1: Messaging's entities are entities INSIDE one operation record.
    // A Thread/Delivery/acceptance/endpoint/inbox file appearing here is the
    // "second store format" the two laws forbid.
    const forbidden = [
      'messages.jsonl', 'threads.jsonl', 'deliveries.jsonl', 'acceptances.jsonl',
      'agentEndpointClaims.jsonl', 'agentInboxItems.jsonl', 'recipientSnapshots.jsonl',
      'deliveryAttempts.jsonl', 'messagingJournal.jsonl',
    ];
    for (const name of forbidden) {
      assert.equal(files.includes(`stores/${name}`), false,
        `${name} exists — Messaging grew a second store file`);
    }

    // Every file that DOES exist is a registered kind's file.
    const registered = new Set([
      'agents.jsonl', 'skills.jsonl', 'layout.jsonl', 'settings.jsonl',
      'conversationViews.jsonl', 'config.jsonl', 'projects.jsonl', 'projectItems.jsonl',
      'artifacts.jsonl', 'spineSteps.jsonl', 'agentRoleProfiles.jsonl',
      'resolvedLaunchPlans.jsonl', 'agentRelationships.jsonl', 'delegationGrants.jsonl',
      'controlReplacementPlans.jsonl', 'providerSessions.jsonl',
      'providerSessionCutovers.jsonl', 'providerUsageEvidence.jsonl', 'agentRuns.jsonl',
      'runContinuations.jsonl', 'supervisionAssignments.jsonl', 'treeMutationFences.jsonl',
      'runOperations.jsonl', 'runOccurrenceEvents.jsonl',
      'terminalSessions.jsonl', 'controllerAttachments.jsonl',
      'terminalInputLeases.jsonl', 'terminalInputAttempts.jsonl',
      'notificationInputReservations.jsonl',
      'messagingStoreOps.jsonl', 'transcriptLines.jsonl', 'transcriptJournal.jsonl',
      'transcriptCheckpoints.jsonl', 'transcriptBindings.jsonl', 'observedSubagents.jsonl',
      'watchRules.jsonl', 'watchDeadlines.jsonl', 'notifications.jsonl',
      'watchEvaluations.jsonl', 'notificationDeliveryFenceOperations.jsonl',
      'terminalTabs.jsonl', 'commandReceipts.jsonl', 'storeRouteCutovers.jsonl',
      'runtimeEpochs.jsonl', 'quarantine.jsonl', 'traces.jsonl',
    ]);
    for (const file of files) {
      const name = path.basename(file);
      assert.equal(registered.has(name), true,
        `${file} is not a §18.1 registered kind file`);
    }

    // The two B3c files that MUST have been written by this run.
    assert.equal(files.includes('stores/messagingStoreOps.jsonl'), true);
    assert.equal(files.includes('stores/transcriptBindings.jsonl'), true);

    // §18.2: every line is the existing {envelope, payload, meta} — no second
    // envelope, no second CAS field.
    for (const file of files) {
      if (path.basename(file) === 'traces.jsonl') continue;
      const full = path.join(root, file);
      if (statSync(full).size === 0) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed).sort(), ['envelope', 'meta', 'payload'],
          `${file} carries a line that is not a Foundation RecordLine`);
        const meta = parsed['meta'] as Record<string, unknown>;
        assert.equal(typeof meta['version'], 'number',
          `${file} has a record line with no meta.version CAS counter`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
