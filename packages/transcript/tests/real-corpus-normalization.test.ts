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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const provider of Object.keys(measuredShapes) as MeasuredProvider[]) {
    const destination = path.join(
      sampleRoot,
      'transcripts',
      provider,
      'measured-sample.jsonl',
    );
    mkdirSync(path.dirname(destination), { recursive: true });
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
        if (count >= SAMPLE_PER_SHAPE) continue;
        appendFileSync(destination, `${content}\n`);
        counts[key] = count + 1;
      }
      if (
        measuredShapes[provider].every(
          (shape) => counts[`${provider}:${shape}`] === SAMPLE_PER_SHAPE,
        )
      ) {
        break;
      }
    }
  }
  return counts;
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
      const sampleCounts = await deriveMeasuredSample(corpusRoot, root);
      const expectedCounts = Object.fromEntries(
        Object.entries(measuredShapes).flatMap(([provider, shapes]) =>
          shapes.map((shape) => [
            `${provider}:${shape}`,
            SAMPLE_PER_SHAPE,
          ]),
        ),
      );
      assert.deepEqual(sampleCounts, expectedCounts);

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
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
