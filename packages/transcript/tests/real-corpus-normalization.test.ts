import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  listObjects,
  type QuarantineTombstone,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeTranscript,
  createRawTranscriptSource,
  type ProviderName,
  type TranscriptRole,
} from '../contract/index.js';

const SAMPLE_PER_SHAPE = 2;

const measuredShapes = {
  claude: [
    'thinking',
    'system_metadata',
  ],
  codex: [
    'token_count',
    'reasoning',
    'agent_reasoning',
    'idless_user_message',
    'idless_agent_message',
  ],
  kimi: [
    'event_journal',
    'message_journal',
    'input_journal',
  ],
} as const;

type MeasuredProvider = keyof typeof measuredShapes;
type MeasuredShape = typeof measuredShapes[MeasuredProvider][number];

interface DerivedMeasuredSample {
  counts: Record<string, number>;
  expectedRoles: Record<string, TranscriptRole[]>;
  shapeRoots: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function groupBySource<T extends { sourceId: string }>(
  lines: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const line of lines) {
    const sourceLines = grouped.get(line.sourceId) ?? [];
    sourceLines.push(line);
    grouped.set(line.sourceId, sourceLines);
  }
  return grouped;
}

function classifyClaude(row: Record<string, unknown>): MeasuredShape | undefined {
  const message = isRecord(row.message) ? row.message : undefined;
  const blocks = Array.isArray(message?.content)
    ? message.content.filter(isRecord)
    : [];
  if (
    blocks.length > 0
    && blocks.every((block) => block.type === 'thinking')
  ) {
    return 'thinking';
  }
  return row.type === 'system' && message === undefined
    ? 'system_metadata'
    : undefined;
}

function classifyCodex(row: Record<string, unknown>): MeasuredShape | undefined {
  const payload = isRecord(row.payload) ? row.payload : undefined;
  if (
    payload?.type === 'token_count'
    || payload?.type === 'reasoning'
    || payload?.type === 'agent_reasoning'
  ) {
    return payload.type;
  }
  if (
    row.type !== 'event_msg'
    || (payload?.type !== 'user_message' && payload?.type !== 'agent_message')
  ) {
    return undefined;
  }
  const metadata = isRecord(
    payload.internal_chat_message_metadata_passthrough,
  )
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  const turnId = payload.turn_id ?? metadata?.turn_id ?? payload.id;
  if (typeof turnId === 'string' && turnId.length > 0) return undefined;
  return payload.type === 'user_message'
    ? 'idless_user_message'
    : 'idless_agent_message';
}

function classifyKimi(row: Record<string, unknown>): MeasuredShape | undefined {
  const keys = Object.keys(row).sort().join(',');
  if (keys === 'event,time,type') return 'event_journal';
  if (keys === 'message,time,type') return 'message_journal';
  if (keys === 'input,origin,time,type') return 'input_journal';
  return undefined;
}

function classify(
  provider: MeasuredProvider,
  row: Record<string, unknown>,
): MeasuredShape | undefined {
  if (provider === 'claude') return classifyClaude(row);
  if (provider === 'codex') return classifyCodex(row);
  return classifyKimi(row);
}

function expectedRole(
  provider: MeasuredProvider,
  shape: MeasuredShape,
  row: Record<string, unknown>,
): TranscriptRole | undefined {
  if (provider === 'codex') {
    if (shape === 'idless_user_message') return 'user';
    if (shape === 'idless_agent_message') return 'assistant';
    return undefined;
  }
  if (provider !== 'kimi') return undefined;
  if (shape === 'input_journal') return 'user';
  if (shape !== 'message_journal' || !isRecord(row.message)) {
    return undefined;
  }
  const message = row.message;
  const parts = Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [];
  if (
    parts.some(
      (part) =>
        part.type === 'attachment'
        || part.type === 'document'
        || part.type === 'image'
        || part.type === 'image_url',
    )
  ) {
    return 'attachment';
  }
  return (
    message.role === 'user'
    || message.role === 'assistant'
    || message.role === 'system'
    || message.role === 'tool'
  )
    ? message.role
    : undefined;
}

function jsonlFilesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return jsonlFilesBelow(entryPath);
      return entry.isFile() && entry.name.endsWith('.jsonl')
        ? [entryPath]
        : [];
    });
}

async function deriveMeasuredSample(
  corpusRoot: string,
  sampleRoot: string,
  samplePerShape = SAMPLE_PER_SHAPE,
): Promise<DerivedMeasuredSample> {
  const counts: Record<string, number> = {};
  const expectedRoles: Record<string, TranscriptRole[]> = {};
  const shapeRoots: Record<string, string> = {};
  for (const provider of Object.keys(measuredShapes) as MeasuredProvider[]) {
    for (
      const source of jsonlFilesBelow(
        path.join(corpusRoot, 'transcripts', provider),
      )
    ) {
      const lines = createInterface({
        input: createReadStream(source),
        crlfDelay: Infinity,
      });
      for await (const content of lines) {
        let row: unknown;
        try {
          row = JSON.parse(content);
        } catch {
          continue;
        }
        if (!isRecord(row)) continue;
        const shape = classify(provider, row);
        if (!shape) continue;
        const key = `${provider}:${shape}`;
        const count = counts[key] ?? 0;
        if (count >= samplePerShape) continue;
        const combinedDestination = path.join(
          sampleRoot,
          'transcripts',
          provider,
          `${shape}.jsonl`,
        );
        const shapeRoot = (
          shapeRoots[key]
          ?? path.join(
            path.dirname(sampleRoot),
            'shape-samples',
            provider,
            shape,
            '.novakai',
          )
        );
        shapeRoots[key] = shapeRoot;
        const isolatedDestination = path.join(
          shapeRoot,
          'transcripts',
          provider,
          'sample.jsonl',
        );
        mkdirSync(path.dirname(combinedDestination), { recursive: true });
        mkdirSync(path.dirname(isolatedDestination), { recursive: true });
        appendFileSync(combinedDestination, `${content}\n`);
        appendFileSync(isolatedDestination, `${content}\n`);
        counts[key] = count + 1;
        const role = expectedRole(provider, shape, row);
        if (role) {
          (expectedRoles[key] ??= []).push(role);
        }
      }
      if (
        measuredShapes[provider].every(
          (shape) => counts[`${provider}:${shape}`] === samplePerShape,
        )
      ) {
        break;
      }
    }
  }
  return { counts, expectedRoles, shapeRoots };
}

async function deriveEmptyAgentMetadataSample(
  corpusRoot: string,
  sampleRoot: string,
): Promise<number> {
  const destination = path.join(
    sampleRoot,
    'transcripts',
    'codex',
    'empty-agent-metadata.jsonl',
  );
  mkdirSync(path.dirname(destination), { recursive: true });
  let count = 0;
  for (
    const source of jsonlFilesBelow(
      path.join(corpusRoot, 'transcripts', 'codex'),
    )
  ) {
    const lines = createInterface({
      input: createReadStream(source),
      crlfDelay: Infinity,
    });
    for await (const content of lines) {
      let row: unknown;
      try {
        row = JSON.parse(content);
      } catch {
        continue;
      }
      if (!isRecord(row) || row.type !== 'event_msg') continue;
      const payload = isRecord(row.payload) ? row.payload : undefined;
      if (
        payload?.type !== 'agent_message'
        || payload.message !== ''
        || (
          !Object.hasOwn(payload, 'phase')
          && !Object.hasOwn(payload, 'memory_citation')
        )
      ) {
        continue;
      }
      appendFileSync(destination, `${content}\n`);
      count += 1;
    }
  }
  return count;
}

test(
  'real custody residual shapes normalize without false quarantine',
  { skip: process.env.NVK_TRANSCRIPT_CORPUS_ROOT === undefined },
  async () => {
    const corpusRoot = path.resolve(
      process.env.NVK_TRANSCRIPT_CORPUS_ROOT!,
    );
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-real-corpus-'));
    const root = path.join(workspace, '.novakai');
    try {
      const sample = await deriveMeasuredSample(corpusRoot, root);
      const expectedCounts = Object.fromEntries(
        Object.entries(measuredShapes).flatMap(([provider, shapes]) =>
          shapes.map((shape) => [
            `${provider}:${shape}`,
            SAMPLE_PER_SHAPE,
          ]),
        ),
      );
      assert.deepEqual(sample.counts, expectedCounts);

      const transcript = composeTranscript({
        root,
        source: createRawTranscriptSource({ root }),
      });
      const ingested = await transcript.ingest();
      assert.equal(ingested.ok, true);
      if (!ingested.ok) return;
      assert.deepEqual(
        {
          added: ingested.value.added,
          skipped: ingested.value.skipped.reduce<Record<string, number>>(
            (counts, entry) => {
              counts[entry.skip.code] = (counts[entry.skip.code] ?? 0) + 1;
              return counts;
            },
            {},
          ),
        },
        {
          added: 8,
          skipped: { non_message: 12 },
        },
      );

      const foundation = composeHandle({
        root,
        dataRoot: path.join(root, 'stores'),
        capability: 'transcript',
        allowedKinds: ['quarantine'],
        principal: 'sys_ingester',
      });
      const quarantined = await listObjects<QuarantineTombstone>(
        foundation,
        'quarantine',
        undefined,
        { limit: 10 },
      );
      assert.equal(quarantined.ok, true);
      assert.equal(quarantined.ok ? quarantined.value.items.length : -1, 0);

      for (const provider of Object.keys(measuredShapes) as ProviderName[]) {
        const lines = await transcript.linesByProvider(provider);
        assert.equal(lines.ok, true);
        assert.equal(
          lines.ok ? lines.value.length : -1,
          provider === 'claude' ? 0 : 4,
        );
        if (provider === 'codex' && lines.ok) {
          assert.equal(
            new Set(lines.value.map((line) => line.sourceId)).size,
            2,
          );
          assert.equal(
            new Set(lines.value.map((line) => line.turnId)).size,
            4,
          );
          assert.ok(
            lines.value.every(
              (line) =>
                line.turnId
                === `codex:${line.sourceId}:${line.turnIndex}`,
            ),
          );
        }
        if (provider === 'kimi' && lines.ok) {
          const indexesBySource = groupBySource(lines.value);
          assert.deepEqual(
            [...indexesBySource.values()].map(
              (sourceLines) => sourceLines.map((line) => line.turnIndex),
            ),
            [[0, 1], [0, 1]],
          );
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'empty Codex agent telemetry is metadata rather than corrupt input',
  { skip: process.env.NVK_TRANSCRIPT_CORPUS_ROOT === undefined },
  async () => {
    const corpusRoot = path.resolve(
      process.env.NVK_TRANSCRIPT_CORPUS_ROOT!,
    );
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-empty-agent-'));
    const root = path.join(workspace, '.novakai');
    try {
      const sampleCount = await deriveEmptyAgentMetadataSample(
        corpusRoot,
        root,
      );
      assert.equal(sampleCount, 2);
      const transcript = composeTranscript({
        root,
        source: createRawTranscriptSource({ root }),
      });
      const ingested = await transcript.ingest();
      assert.deepEqual(
        ingested.ok
          ? {
              added: ingested.value.added,
              skipped: ingested.value.skipped.map(
                (entry) => entry.skip.code,
              ),
            }
          : null,
        { added: 0, skipped: ['non_message', 'non_message'] },
      );

      const foundation = composeHandle({
        root,
        dataRoot: path.join(root, 'stores'),
        capability: 'transcript',
        allowedKinds: ['quarantine'],
        principal: 'sys_ingester',
      });
      const quarantined = await listObjects<QuarantineTombstone>(
        foundation,
        'quarantine',
        undefined,
        { limit: 10 },
      );
      assert.equal(
        quarantined.ok ? quarantined.value.items.length : -1,
        0,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'approximately 5000 real custody rows exercise every measured residual shape',
  {
    skip:
      process.env.NVK_TRANSCRIPT_CORPUS_ROOT === undefined
      || process.env.NVK_TRANSCRIPT_MEASURE_REAL_CORPUS !== '1',
  },
  async () => {
    const corpusRoot = path.resolve(
      process.env.NVK_TRANSCRIPT_CORPUS_ROOT!,
    );
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-real-measure-'));
    const root = path.join(workspace, '.novakai');
    try {
      const sample = await deriveMeasuredSample(corpusRoot, root, 500);
      assert.equal(
        Object.values(sample.counts).reduce(
          (total, count) => total + count,
          0,
        ),
        5_000,
      );
      assert.equal(Object.keys(sample.counts).length, 10);

      for (const [key, count] of Object.entries(sample.counts)) {
        const [provider, shape] = key.split(':') as [
          MeasuredProvider,
          MeasuredShape,
        ];
        const source = createRawTranscriptSource({
          root: sample.shapeRoots[key]!,
        });
        const discoveredSources = [];
        const items = [];
        for await (const discovered of source.sources()) {
          discoveredSources.push(discovered);
          for await (const item of source.read(discovered, 0)) {
            items.push(item);
          }
        }
        assert.equal(discoveredSources.length, 1, key);
        assert.equal(items.length, count, key);

        const candidateShape = (
          shape === 'idless_user_message'
          || shape === 'idless_agent_message'
          || shape === 'message_journal'
          || shape === 'input_journal'
        );
        if (!candidateShape) {
          assert.deepEqual(
            items.map((item) =>
              item.kind === 'skip' ? item.reason.code : item.kind
            ),
            Array.from({ length: count }, () => 'non_message'),
            key,
          );
          continue;
        }
        assert.ok(
          items.every((item) => item.kind === 'candidate'),
          key,
        );
        const candidates = items.filter(
          (item) => item.kind === 'candidate',
        );
        assert.deepEqual(
          candidates.map((item) => item.line.role),
          sample.expectedRoles[key],
          `${key} roles retain source order`,
        );
        assert.deepEqual(
          candidates.map((item) => item.line.turnIndex),
          Array.from({ length: count }, (_, index) => index),
          `${key} indexes retain source order`,
        );
        if (provider === 'codex') {
          const sourceId = discoveredSources[0]!.sourceId;
          assert.deepEqual(
            candidates.map((item) => item.line.turnId),
            Array.from(
              { length: count },
              (_, index) => `${sourceId}:${index}`,
            ),
            `${key} turns are scoped to the discovered source`,
          );
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
