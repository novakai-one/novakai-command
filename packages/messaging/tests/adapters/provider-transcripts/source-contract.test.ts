import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentIdentityHookCommand,
  createDefaultMessagingRuntime,
  createMemoryTranscriptStore,
  createMessagingRuntime,
  createProviderTranscriptSource,
  ensureClaudeIdentityHook,
  ensureCodexIdentityHook,
  ensureKimiIdentityHook,
  findAgentIdentityMarker,
  providerNormalizer,
  runAgentIdentityHook,
  type AgentDirectory,
  type IngestCheckpoint,
  type ProviderLineExtent,
  type ProviderName,
} from "../../../contract/index.js";

test('runtime keeps its retry timer when the first provider scan fails', async () => {
  let scans = 0;
  const runtime = createMessagingRuntime({
    store: createMemoryTranscriptStore(),
    source: {
      async scan() {
        scans += 1;
        if (scans === 1) throw new Error('injected first-scan failure');
        return [];
      },
      async readGrowth() { throw new Error('no source should be read'); },
    },
    normalizers: {
      claude: providerNormalizer('claude'),
      codex: providerNormalizer('codex'),
      kimi: providerNormalizer('kimi'),
    },
    intervalMs: 5,
  });
  try {
    assert.equal((await runtime.start()).kind, 'ok');
    const deadline = Date.now() + 250;
    while (scans < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(scans >= 2);
    const health = await runtime.health();
    assert.equal(health.state, 'running');
    assert.ok(health.runs >= 1);
  } finally {
    await runtime.stop();
  }
});

const hash = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function normalize(provider: ProviderName, row: unknown, index = 0) {
  const raw = JSON.stringify(row);
  const extent: ProviderLineExtent = {
    raw,
    offset: 0,
    nextOffset: Buffer.byteLength(raw) + 1,
  };
  return providerNormalizer(provider).normalize(extent, index);
}

test("provider normalizers retain conversation, identity and tool evidence", () => {
  const claude = normalize("claude", {
    type: "assistant",
    uuid: "claude-line-1",
    parentUuid: "claude-parent-1",
    sessionId: "claude-session-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Claude reply" }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  });
  assert.deepEqual(
    [claude.role, claude.text, claude.providerLineId, claude.resumeId],
    ["assistant", "Claude reply", "claude-line-1", "claude-session-1"],
  );

  const codex = normalize("codex", {
    type: "response_item",
    payload: { type: "function_call", call_id: "call-1", name: "shell" },
  });
  assert.equal(codex.role, "tool_call");
  assert.equal(codex.providerLineId, "response_item:function_call:call-1");

  const kimi = normalize("kimi", {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "kimi-line-1",
      turnId: "7",
      part: { type: "text", text: "Kimi reply" },
    },
  });
  assert.deepEqual(
    [kimi.role, kimi.text, kimi.providerLineId, kimi.turnId],
    ["assistant", "Kimi reply", "kimi-line-1", "7"],
  );
});

test("provider adapters expose only canonical conversation messages", () => {
  const cases: Array<{ provider: ProviderName; rows: unknown[] }> = [
    {
      provider: 'claude',
      rows: [
        { type: 'user', message: { role: 'user', content: 'Claude prompt' } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Claude reply' }] },
        },
      ],
    },
    {
      provider: 'codex',
      rows: [
        {
          type: 'response_item',
          payload: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: '<recommended_plugins>internal</recommended_plugins>' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'Codex prompt' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Codex prompt' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Codex reply' } },
        {
          type: 'response_item',
          payload: {
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Codex reply' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        },
      ],
    },
    {
      provider: 'kimi',
      rows: [
        { type: 'turn.prompt', input: [{ type: 'text', text: 'Kimi prompt' }] },
        {
          type: 'context.append_message',
          message: { role: 'user', origin: { kind: 'user' }, content: 'Kimi prompt' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user', origin: { kind: 'injection' },
            content: '<system-reminder>internal</system-reminder>',
          },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: 'Kimi reply' } },
        },
      ],
    },
  ];
  for (const fixture of cases) {
    const visible = fixture.rows
      .map((row, index) => normalize(fixture.provider, row, index))
      .filter((line) => line.audience === 'conversation')
      .map((line) => [line.role, line.text]);
    assert.deepEqual(visible, [
      ['user', `${fixture.provider[0]?.toUpperCase()}${fixture.provider.slice(1)} prompt`],
      ['assistant', `${fixture.provider[0]?.toUpperCase()}${fixture.provider.slice(1)} reply`],
    ], fixture.provider);
  }
  assert.equal(normalize('kimi', {
    type: 'context.append_message',
    message: { role: 'assistant', content: 'Kimi alternate reply envelope' },
  }).audience, 'conversation');
});

test("one identity marker normalizes as hidden hook evidence on all providers", () => {
  const marker = {
    kind: "novakai-agent-identity",
    schemaVersion: 1,
    hookEvent: "UserPromptSubmit",
    agentId: "agent_abc123",
  };
  const claude = normalize("claude", {
    type: "system",
    subtype: "hook_response",
    sessionId: "claude-session",
    message: { role: "system", content: [{ type: "hook_result", content: JSON.stringify(marker) }] },
  });
  const codex = normalize("codex", {
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: JSON.stringify(marker) }] },
  });
  const kimi = normalize("kimi", {
    message: { role: "system", content: `<hook_result hook_event="UserPromptSubmit">${JSON.stringify(marker)}</hook_result>` },
  });
  for (const candidate of [claude, codex, kimi]) {
    assert.equal(candidate.role, "hook");
    assert.equal(candidate.agentIdentity?.agentId, marker.agentId);
  }
  let output = "";
  assert.equal(runAgentIdentityHook({ NOVAKAI_AGENT_ID: marker.agentId }, (line) => { output += line; }), true);
  assert.deepEqual(findAgentIdentityMarker(output), marker);
  assert.match(agentIdentityHookCommand(), /NOVAKAI_AGENT_ID/);
});

test("hook assignment attaches the discovered ProviderSession before lines become visible", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "nvk-provider-assignment-"));
  const root = path.join(base, ".novakai");
  const providerHome = path.join(base, "provider-home");
  const transcriptDir = path.join(providerHome, ".claude", "projects", "fixture");
  await mkdir(transcriptDir, { recursive: true });
  const marker = {
    kind: "novakai-agent-identity",
    schemaVersion: 1,
    hookEvent: "UserPromptSubmit",
    agentId: "agent_attached",
  };
  await writeFile(path.join(transcriptDir, "session.jsonl"), `${JSON.stringify({
    type: "system",
    subtype: "hook_response",
    sessionId: "claude-provider-session",
    message: { role: "system", content: [{ type: "hook_result", content: JSON.stringify(marker) }] },
  })}\n`);
  const calls: string[] = [];
  const agentDirectory: AgentDirectory = {
    async get(agentId) {
      return agentId === marker.agentId
        ? { agentId, provider: "claude", currentProviderSessionId: null }
        : null;
    },
    async ensureForSession() {
      return { ok: false, code: "NotExpected", message: "hook assignment does not adopt" };
    },
    async deliveryReadiness() { return "idle"; },
    async attachProviderSession(agentId, providerSessionId) {
      calls.push(`${agentId}:${providerSessionId}`);
      return { ok: true, state: "attached" };
    },
  };
  const composed = await createDefaultMessagingRuntime({ root, providerHome, agentDirectory });
  try {
    const ingested = await composed.runtime.ingestNow();
    assert.equal(ingested.kind, "ok");
    const sessions = await composed.runtime.listProviderSessions();
    const lines = await composed.runtime.listTranscriptLines();
    assert.equal(sessions.kind === "ok" && sessions.value[0]?.agentId, marker.agentId);
    assert.equal(lines.kind === "ok" && lines.value[0]?.agentIdentity?.agentId, marker.agentId);
    assert.equal(calls.length, 1);
    const settings = JSON.parse(await readFile(
      path.join(providerHome, ".claude", "settings.json"), "utf8",
    ));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    const codexHooks = JSON.parse(await readFile(
      path.join(providerHome, ".codex", "hooks.json"), "utf8",
    ));
    assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
    const kimiConfig = await readFile(
      path.join(providerHome, ".kimi-code", "config.toml"), "utf8",
    );
    assert.equal((kimiConfig.match(/\[\[hooks\]\]/gu) ?? []).length, 1);
    assert.match(kimiConfig, /event = "UserPromptSubmit"/u);

    const command = agentIdentityHookCommand();
    assert.equal(await ensureClaudeIdentityHook({ providerHome, command }), "unchanged");
    assert.equal(await ensureCodexIdentityHook({ providerHome, command }), "unchanged");
    assert.equal(await ensureKimiIdentityHook({ providerHome, command }), "unchanged");
  } finally {
    await composed.close();
  }
});

test('a foreign marker is skipped without blocking an owned source in the same tick', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nvk-provider-ownership-'));
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const transcriptDir = path.join(providerHome, '.claude', 'projects', 'fixture');
  await mkdir(transcriptDir, { recursive: true });
  const localStoreId = 'store_11111111-1111-4111-8111-111111111111';
  const markerRow = (sessionId: string, storeId: string, agentId: string) => JSON.stringify({
    type: 'system', subtype: 'hook_response', sessionId,
    message: {
      role: 'system',
      content: [{
        type: 'hook_result',
        content: JSON.stringify({
          kind: 'novakai-agent-identity', schemaVersion: 2,
          hookEvent: 'UserPromptSubmit', storeId, agentId,
        }),
      }],
    },
  });
  const replyRow = (sessionId: string, uuid: string, text: string) => JSON.stringify({
    type: 'assistant', uuid, sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  await Promise.all([
    writeFile(path.join(transcriptDir, 'foreign.jsonl'), [
      markerRow('foreign-session', 'store_22222222-2222-4222-8222-222222222222', 'agent_foreign'),
      replyRow('foreign-session', 'foreign-reply', 'must stay hidden'),
      '',
    ].join('\n')),
    writeFile(path.join(transcriptDir, 'owned.jsonl'), [
      markerRow('owned-session', localStoreId, 'agent_owned'),
      replyRow('owned-session', 'owned-reply', 'owned reply'),
      '',
    ].join('\n')),
    writeFile(path.join(transcriptDir, 'invalid-owned.jsonl'), [
      markerRow('invalid-owned-session', localStoreId, 'agent_missing'),
      replyRow('invalid-owned-session', 'invalid-owned-reply', 'must also stay hidden'),
      '',
    ].join('\n')),
  ]);
  const agentDirectory: AgentDirectory = {
    async get(agentId) {
      return agentId === 'agent_owned'
        ? { agentId, provider: 'claude', currentProviderSessionId: null }
        : null;
    },
    async ensureForSession() {
      return { ok: false, code: 'NotExpected', message: 'markers do not adopt' };
    },
    async deliveryReadiness() { return 'idle'; },
    async attachProviderSession() { return { ok: true, state: 'attached' }; },
  };
  const composed = await createDefaultMessagingRuntime({
    root, providerHome, agentDirectory, storeId: localStoreId as never,
  });
  try {
    const result = await composed.runtime.ingestNow();
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.value.foreignSources, 1);
      assert.equal(result.value.failedSources, 1);
      assert.match(result.value.failures[0]?.message ?? '', /missing Agent agent_missing/u);
    }
    const lines = await composed.runtime.listTranscriptLines();
    assert.equal(lines.kind, 'ok');
    if (lines.kind === 'ok') {
      assert.ok(lines.value.some((line) => line.text === 'owned reply'));
      assert.ok(lines.value.every((line) => line.text !== 'must stay hidden'));
      assert.ok(lines.value.every((line) => line.text !== 'must also stay hidden'));
    }
  } finally {
    await composed.close();
  }
});

test("scan is metadata-only; growth reads verification tail plus new bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nvk-provider-source-"));
  const file = path.join(root, "session_628269c7-9bc3-423f-a236-0d5ecab85c64.jsonl");
  const first = Buffer.from(`${JSON.stringify({ type: "system" })}\n`);
  await writeFile(file, first);
  const reads: Array<{ from: number; length: number }> = [];
  const source = createProviderTranscriptSource({ kimi: [root] }, {
    async readRange(filePath, from, length) {
      reads.push({ from, length });
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, from);
        return buffer.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    },
  });

  const [stat] = await source.scan();
  assert.ok(stat);
  assert.equal(reads.length, 0, "stat scan opens no content range");
  const initial = await source.readGrowth(stat, null);
  assert.deepEqual(Buffer.from(initial.bytes), first);
  assert.equal(reads.length, 1);
  const checkpoint: IngestCheckpoint = {
    id: `ingestCheckpoint_${"b".repeat(64)}` as never,
    kind: "ingest-checkpoint",
    schemaVersion: 1,
    createdAt: "2026-08-25T00:00:00.000Z" as never,
    updatedAt: "2026-08-25T00:00:00.000Z" as never,
    provider: "kimi",
    sourceId: stat.sourceId,
    sourceEpoch: 0,
    offset: first.length,
    nextTurnIndex: 1,
    fileSignature: {
      device: stat.device,
      inode: stat.inode,
      tailHash: hash(first.subarray(-64)),
    },
  };
  const [unchanged] = await source.scan();
  assert.ok(unchanged);
  const empty = await source.readGrowth(unchanged, checkpoint);
  assert.equal(empty.bytes.byteLength, 0);
  assert.equal(reads.length, 1, "unchanged source reads zero content bytes");

  const second = Buffer.from(`${JSON.stringify({ type: "assistant" })}\n`);
  await appendFile(file, second);
  const [grown] = await source.scan();
  assert.ok(grown);
  const growth = await source.readGrowth(grown, checkpoint);
  assert.deepEqual(Buffer.from(growth.bytes), second);
  assert.deepEqual(Buffer.from(growth.priorTail), first.subarray(-64));
  assert.deepEqual(reads.at(-1), {
    from: Math.max(0, checkpoint.offset - 64),
    length: grown.size - Math.max(0, checkpoint.offset - 64),
  });
});

test("unscoped growth is byte-bounded while an adoption root may migrate atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nvk-provider-byte-budget-"));
  const file = path.join(root, "large.jsonl");
  const row = `${JSON.stringify({ type: "assistant", message: { content: "x".repeat(1_000) } })}\n`;
  const contents = Buffer.from(row.repeat(3_000));
  await writeFile(file, contents);

  const unscoped = createProviderTranscriptSource({ claude: [root] });
  const [unscopedStat] = await unscoped.scan();
  assert.ok(unscopedStat);
  const bounded = await unscoped.readGrowth(unscopedStat, null);
  assert.ok(bounded.bytes.byteLength < contents.byteLength);
  assert.ok(bounded.bytes.byteLength <= 2 * 1024 * 1024);

  const adopted = createProviderTranscriptSource({ claude: [root] }, {
    adoptRoots: { claude: [root] },
  });
  const [adoptedStat] = await adopted.scan();
  assert.ok(adoptedStat?.adoptionEligible);
  const complete = await adopted.readGrowth(adoptedStat, null);
  assert.equal(complete.bytes.byteLength, contents.byteLength);
});

test("truncate then regrow recalibrates only that source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nvk-provider-recalibrate-"));
  const file = path.join(root, "session.jsonl");
  const original = Buffer.from(`${JSON.stringify({ text: "old" })}\n`);
  await writeFile(file, original);
  const source = createProviderTranscriptSource({ claude: [root] });
  const [stat] = await source.scan();
  assert.ok(stat);
  const checkpoint: IngestCheckpoint = {
    id: `ingestCheckpoint_${"c".repeat(64)}` as never,
    kind: "ingest-checkpoint",
    schemaVersion: 1,
    createdAt: "2026-08-25T00:00:00.000Z" as never,
    updatedAt: "2026-08-25T00:00:00.000Z" as never,
    provider: "claude",
    sourceId: stat.sourceId,
    sourceEpoch: 0,
    offset: original.length,
    nextTurnIndex: 1,
    fileSignature: {
      device: stat.device,
      inode: stat.inode,
      tailHash: hash(original),
    },
  };
  const replacement = Buffer.from(`${JSON.stringify({ text: "replacement-longer-than-old" })}\n`);
  await writeFile(file, replacement);
  const [regrown] = await source.scan();
  assert.ok(regrown);
  const growth = await source.readGrowth(regrown, checkpoint);
  assert.equal(growth.sourceEpoch, 1);
  assert.equal(growth.fromOffset, 0);
  assert.deepEqual(Buffer.from(growth.bytes), replacement);
});

test("default cadence exposes an appended provider reply within two seconds", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "nvk-provider-cadence-"));
  const root = path.join(base, ".novakai");
  const providerHome = path.join(base, "provider-home");
  const sessionDir = path.join(
    providerHome,
    ".kimi-code",
    "sessions",
    "wd_fixture",
    "session_628269c7-9bc3-423f-a236-0d5ecab85c64",
    "agents",
    "main",
  );
  const sessionFile = path.join(sessionDir, "wire.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, "");
  const latencyAgent = "agent_latency";
  const agentDirectory: AgentDirectory = {
    async get(agentId) {
      return agentId === latencyAgent
        ? { agentId, provider: "kimi", currentProviderSessionId: null }
        : null;
    },
    async ensureForSession() {
      return { ok: false, code: "NotExpected", message: "hook path does not adopt" };
    },
    async deliveryReadiness() { return "idle"; },
    async attachProviderSession() { return { ok: true, state: "attached" }; },
  };
  const composed = await createDefaultMessagingRuntime({ root, providerHome, agentDirectory });
  try {
    assert.equal((await composed.runtime.start()).kind, "ok");
    const appendedAt = Date.now();
    const marker = JSON.stringify({
      kind: "novakai-agent-identity",
      schemaVersion: 1,
      hookEvent: "UserPromptSubmit",
      agentId: latencyAgent,
    });
    await appendFile(sessionFile, `${JSON.stringify({
      message: {
        role: "system",
        content: `<hook_result hook_event="UserPromptSubmit">${marker}</hook_result>`,
      },
    })}\n${JSON.stringify({
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        uuid: "kimi-latency-line",
        turnId: "turn-latency",
        part: { type: "text", text: "visible reply" },
      },
    })}\n`);
    let visible = false;
    while (Date.now() - appendedAt < 2_000) {
      const lines = await composed.runtime.listTranscriptLines();
      if (lines.kind === "ok" && lines.value.some((line) => line.text === "visible reply")) {
        visible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(visible, true);
    assert.ok(Date.now() - appendedAt < 2_000);
  } finally {
    await composed.close();
  }
});
