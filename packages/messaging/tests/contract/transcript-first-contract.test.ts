import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMessagingRuntime } from "../../core/ingestion/messaging-runtime.js";
import { createMemoryTranscriptStore } from "../../adapters/stores/memory.js";
import { openFoundationTranscriptStore } from "../../adapters/stores/jsonl.js";
import { providerNormalizer } from "../../adapters/provider-transcripts/normalizers/index.js";
import type { AgentDirectory } from "../../contract/ports/agent-directory.js";
import type { ProviderSessionId } from "../../contract/types.js";
import type {
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { TranscriptStore } from "../../contract/ports/transcript-store.js";

const row = JSON.stringify({
  type: "assistant",
  uuid: "row-1",
  sessionId: "provider-native-session",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
});
const bytes = Buffer.from(`${row}\n`);

const sourceStat: ProviderSourceStat = {
  sourceId: `source_${"a".repeat(64)}` as never,
  provider: "claude",
  size: bytes.length,
  device: "1",
  inode: "2",
  adoptionEligible: true,
  modifiedAt: "2026-08-25T00:00:00.000Z",
};

function fixtureSource(): ProviderTranscriptSource & { reads: number } {
  return {
    reads: 0,
    scan: async () => [sourceStat],
    async readGrowth(_source, checkpoint): Promise<ProviderSourceGrowth> {
      this.reads += 1;
      return {
        sourceId: sourceStat.sourceId,
        provider: "claude",
        sourceEpoch: checkpoint?.sourceEpoch ?? 0,
        fromOffset: checkpoint?.offset ?? 0,
        priorTail: Buffer.alloc(0),
        bytes: checkpoint === null ? bytes : Buffer.alloc(0),
        signatureAtRead: { device: "1", inode: "2" },
      };
    },
  };
}

const normalizers = {
  claude: providerNormalizer("claude"),
  codex: providerNormalizer("codex"),
  kimi: providerNormalizer("kimi"),
} as const;

function adoption() {
  let currentProviderSessionId: ProviderSessionId | null = null;
  const agentDirectory: AgentDirectory = {
    async get(agentId) {
      return agentId === 'agent_external'
        ? { agentId, provider: 'claude', currentProviderSessionId }
        : null;
    },
    async ensureForSession() {
      return {
        ok: true,
        agent: { agentId: 'agent_external', provider: 'claude', currentProviderSessionId },
      };
    },
    async deliveryReadiness() { return 'idle'; },
    async attachProviderSession(_agentId, providerSessionId) {
      const replay = currentProviderSessionId === providerSessionId;
      currentProviderSessionId = providerSessionId as ProviderSessionId;
      return { ok: true, state: replay ? 'already-attached' : 'attached' };
    },
  };
  return {
    agentDirectory,
    adoption: {
      assignment: { teamId: 'team_external', missionId: 'mission_external' },
      conversations: {
        async ensureForAdoptedAgent() { return { conversationId: 'conv_external' }; },
        async ensureForAgentPair() { return { conversationId: 'conv_agents' }; },
      },
      limitPerTick: 10,
    },
  } as const;
}

test("registration, line and checkpoint commit once in durable event order", async () => {
  const store = createMemoryTranscriptStore();
  const source = fixtureSource();
  const runtime = createMessagingRuntime({
    store,
    source,
    normalizers,
    now: () => "2026-08-25T00:00:00.000Z",
    ...adoption(),
  });

  const first = await runtime.ingestNow();
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  assert.deepEqual(first.value, {
    sources: 1,
    added: 1,
    duplicates: 0,
    sessionsRegistered: 1,
    sessionsAdopted: 1,
    foreignSources: 0,
    failedSources: 0,
    failures: [],
  });
  const sessions = await store.listProviderSessions();
  const lines = await store.listTranscriptLines();
  assert.equal(sessions.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.sessionId, sessions[0]?.id);
  assert.equal(lines[0]?.raw, row);
  const messages = await runtime.listAgentConversationMessages({ agentId: 'agent_external' });
  assert.deepEqual(messages.kind === 'ok'
    ? messages.value.map((message) => [message.role, message.text]) : [], [
    ['assistant', 'hello'],
  ]);
  assert.notEqual(sessions[0]?.id, sessions[0]?.resumeId,
    "Novakai Session ID and provider Resume ID stay distinct");
  assert.deepEqual(
    (await store.scanTranscriptEvents()).map((event) => event.kind),
    ["provider-session.registered", "transcript-line.appended"],
  );

  const replay = await runtime.ingestNow();
  assert.equal(replay.kind, "ok");
  if (replay.kind === "ok") assert.equal(replay.value.added, 0);
  assert.equal(source.reads, 1, "unchanged source reads zero content bytes");
  assert.equal((await store.listTranscriptLines()).length, 1);
});

test("a pre-commit crash retries to one TranscriptLine", async () => {
  const durable = createMemoryTranscriptStore();
  let fail = true;
  const store: TranscriptStore = {
    ...durable,
    async commitIngestBatch(input) {
      if (fail) {
        fail = false;
        throw new Error("injected before checkpoint commit");
      }
      return durable.commitIngestBatch(input);
    },
  };
  const runtime = createMessagingRuntime({
    store,
    source: fixtureSource(),
    normalizers,
    now: () => "2026-08-25T00:00:00.000Z",
    ...adoption(),
  });
  const failedPass = await runtime.ingestNow();
  assert.equal(failedPass.kind, 'ok');
  if (failedPass.kind === 'ok') {
    assert.equal(failedPass.value.failedSources, 1);
    assert.match(failedPass.value.failures[0]?.message ?? '', /before checkpoint commit/u);
  }
  const retry = await runtime.ingestNow();
  assert.equal(retry.kind, 'ok');
  if (retry.kind === 'ok') assert.equal(retry.value.failedSources, 0);
  assert.equal((await durable.listTranscriptLines()).length, 1);
});

test("the same provider event in a moved source remains one TranscriptLine", async () => {
  const store = createMemoryTranscriptStore();
  const movedSource: ProviderTranscriptSource = {
    scan: async () => [
      sourceStat,
      { ...sourceStat, sourceId: `source_${"d".repeat(64)}` as never, inode: "3" },
    ],
    async readGrowth(source, checkpoint) {
      return {
        sourceId: source.sourceId,
        provider: source.provider,
        sourceEpoch: checkpoint?.sourceEpoch ?? 0,
        fromOffset: checkpoint?.offset ?? 0,
        priorTail: Buffer.alloc(0),
        bytes: checkpoint === null ? bytes : Buffer.alloc(0),
        signatureAtRead: { device: source.device, inode: source.inode },
      };
    },
  };
  const runtime = createMessagingRuntime({
    store,
    source: movedSource,
    normalizers,
    now: () => "2026-08-25T00:00:00.000Z",
    ...adoption(),
  });
  const result = await runtime.ingestNow();
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.added, 1);
  assert.equal(result.value.duplicates, 1);
  assert.equal((await store.listProviderSessions()).length, 1);
  assert.equal((await store.listTranscriptLines()).length, 1);
});

test("ambiguous historical provider evidence is isolated and stays unbound", async () => {
  const store = createMemoryTranscriptStore();
  const shared = {
    kind: "provider-session" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-08-25T00:00:00.000Z" as never,
    provider: "claude" as const,
    status: "adoption-pending" as const,
    resumeId: "provider-native-session" as never,
  };
  await store.upsertProviderSession({
    ...shared,
    id: `sess_${"1".repeat(32)}` as never,
    sourceIds: [sourceStat.sourceId],
  });
  await store.upsertProviderSession({
    ...shared,
    id: `sess_${"2".repeat(32)}` as never,
    sourceIds: [`source_${"b".repeat(64)}` as never],
  });
  const runtime = createMessagingRuntime({
    store,
    source: fixtureSource(),
    normalizers,
    now: () => "2026-08-25T00:00:00.000Z",
    ...adoption(),
  });

  const result = await runtime.ingestNow();
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.failedSources, 1);
  assert.match(result.value.failures[0]?.message ?? '', /matches multiple sessions/u);
  assert.equal((await store.listTranscriptLines()).length, 0);
  assert.equal((await store.listProviderSessions()).every((session) =>
    session.agentId === undefined), true);
});

test("Foundation adapter writes and replays only the canonical Messaging database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nvk-messaging-ingest-"));
  const dataRoot = path.join(root, "stores");
  const store = await openFoundationTranscriptStore({ root, dataRoot });
  const runtime = createMessagingRuntime({
    store,
    source: fixtureSource(),
    normalizers,
    now: () => "2026-08-25T00:00:00.000Z",
    ...adoption(),
  });
  assert.equal((await runtime.ingestNow()).kind, "ok");
  await store.close();

  const messagingFiles = (await readdir(dataRoot))
    .filter((name) => name.toLowerCase().includes("messaging"));
  assert.deepEqual(messagingFiles, ["messagingStoreOps.jsonl"]);
  const reopened = await openFoundationTranscriptStore({ root, dataRoot });
  assert.equal((await reopened.listTranscriptLines()).length, 1);
  await reopened.close();
});
