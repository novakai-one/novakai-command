import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  ProviderName,
  type TranscriptRelationState,
  type TranscriptSource,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import type { TranscriptReadCursor } from '../contract/source.js';
import type { TranscriptSourceAdapter } from '../contract/source.js';
import { applyTranscriptRelationDelta } from '../core/relations.js';
import {
  normalizeProviderLine,
  type ProviderAgentResolver,
  type ProviderSessionResolver,
} from './provider-normalizers.js';

export type {
  ProviderAgentResolver,
  ProviderSessionResolver,
} from './provider-normalizers.js';

export interface RawTranscriptSourceOptions {
  /** The .novakai root containing recursive provider JSONL copies. */
  root: string;
  resolveSessionRef?: ProviderSessionResolver;
  resolveAgentId?: ProviderAgentResolver;
}

async function* filesBelow(
  dir: string,
  prefix = '',
): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return;
    throw cause;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const entryPath = path.join(dir, entry.name);
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error('provider transcript tree must not contain symlinks');
    }
    if (stat.isDirectory()) {
      yield* filesBelow(entryPath, relative);
    } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
      yield relative;
    }
  }
}

async function* providerFiles(
  providerRoot: string,
  transcriptsRoot: string,
): AsyncIterable<string> {
  let stat;
  try {
    stat = await lstat(providerRoot);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return;
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    throw new Error('provider transcript root must not be a symlink');
  }
  if (!stat.isDirectory()) return;
  const [realProviderRoot, realTranscriptsRoot] = await Promise.all([
    realpath(providerRoot),
    realpath(transcriptsRoot),
  ]);
  const relative = path.relative(realTranscriptsRoot, realProviderRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('provider transcript root escapes transcript custody');
  }
  yield* filesBelow(providerRoot);
}

function opaqueSourceId(provider: string, relativePath: string): string {
  const portablePath = relativePath.split(path.sep).join('/');
  const digest = createHash('sha256')
    .update(`${provider}:${portablePath}`)
    .digest('hex');
  return `source_${digest}`;
}

class RawTranscriptSource implements TranscriptSourceAdapter {
  private readonly root: string;
  private currentSource?: {
    key: string;
    file: string;
  };

  constructor(private readonly options: RawTranscriptSourceOptions) {
    this.root = path.resolve(options.root);
  }

  async *sources(): AsyncIterable<TranscriptSource> {
    this.currentSource = undefined;
    const transcriptsRoot = path.join(this.root, 'transcripts');
    let transcriptsStat;
    try {
      transcriptsStat = await lstat(transcriptsRoot);
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return;
      throw cause;
    }
    if (transcriptsStat.isSymbolicLink()) {
      throw new Error('transcript custody root must not be a symlink');
    }
    if (!transcriptsStat.isDirectory()) return;
    for (const provider of ProviderName.options) {
      const providerRoot = path.join(transcriptsRoot, provider);
      for await (
        const relativePath of providerFiles(
          providerRoot,
          transcriptsRoot,
        )
      ) {
        const sourceId = opaqueSourceId(provider, relativePath);
        const discovered = {
          key: `${provider}:${sourceId}`,
          file: path.resolve(providerRoot, relativePath),
        };
        this.currentSource = discovered;
        try {
          yield { provider, sourceId };
        } finally {
          if (this.currentSource === discovered) {
            this.currentSource = undefined;
          }
        }
      }
    }
  }

  async *read(
    source: TranscriptSource,
    fromOffset: number,
    relationState?: TranscriptRelationState,
    readCursor?: TranscriptReadCursor,
  ): AsyncIterable<TranscriptSourceItem> {
    const key = `${source.provider}:${source.sourceId}`;
    const discovered = this.currentSource;
    if (!discovered || discovered.key !== key) {
      throw new Error('transcript source is not discovered');
    }
    try {
      const stat = await lstat(discovered.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('transcript source is not a regular file');
      }
      let buffered = Buffer.alloc(0);
      let cursor = fromOffset;
      let currentRelations = relationState;
      let nextTurnIndex = readCursor?.nextTurnIndex ?? 0;
      let lastTurnId = readCursor?.lastTurnId;
      for await (
        const chunk of createReadStream(
          discovered.file,
          { start: fromOffset },
        )
      ) {
        buffered = Buffer.concat([buffered, chunk as Buffer]);
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0) {
          let raw = buffered.subarray(0, newline);
          if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
          const nextOffset = cursor + newline + 1;
          const item = normalizeProviderLine(
            source.provider,
            raw.toString('utf8'),
            cursor,
            nextOffset,
            this.options.resolveSessionRef,
            currentRelations,
            this.options.resolveAgentId,
            nextTurnIndex,
          );
          if (
            item.kind === 'candidate'
            && source.provider !== 'kimi'
          ) {
            const sameTurn = (
              item.line.turnId !== undefined
              && item.line.turnId === lastTurnId
            );
            item.line.turnIndex = sameTurn
              ? Math.max(0, nextTurnIndex - 1)
              : nextTurnIndex;
            if (!sameTurn) nextTurnIndex += 1;
            lastTurnId = item.line.turnId;
          }
          if ('relation' in item && item.relation) {
            currentRelations = applyTranscriptRelationDelta(
              currentRelations ?? { parents: {}, children: {} },
              item.relation,
            );
          }
          yield item;
          buffered = buffered.subarray(newline + 1);
          cursor = nextOffset;
          newline = buffered.indexOf(0x0a);
        }
      }
    } finally {
      if (this.currentSource === discovered) {
        this.currentSource = undefined;
      }
    }
  }
}

export function createRawTranscriptSource(
  options: RawTranscriptSourceOptions,
): TranscriptSourceAdapter {
  return new RawTranscriptSource(options);
}
