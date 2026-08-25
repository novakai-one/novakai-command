import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentIdentityHookCommand,
  createDefaultMessagingRuntime,
  createProviderTranscriptSource,
  providerNormalizer,
  runAgentIdentityHook,
  type AgentDirectory,
  type IngestCheckpoint,
  type ProviderLineExtent,
  type ProviderName,
} from "../../../contract/index.js";

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
  assert.deepEqual(JSON.parse(output), marker);
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
