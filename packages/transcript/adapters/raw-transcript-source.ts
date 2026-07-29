import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ProviderName,
  type TranscriptSource,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import type { TranscriptSourceAdapter } from '../contract/source.js';
import {
  normalizeProviderLine,
  type ProviderSessionResolver,
} from './provider-normalizers.js';

export type { ProviderSessionResolver } from './provider-normalizers.js';

export interface RawTranscriptSourceOptions {
  /** The .novakai root containing recursive provider JSONL copies. */
  root: string;
  resolveSessionRef?: ProviderSessionResolver;
}

async function filesBelow(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return [];
    throw cause;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await filesBelow(path.join(dir, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(relative);
    }
  }
  return files;
}

function sourcePath(root: string, source: TranscriptSource): string {
  const providerRoot = path.resolve(root, 'transcripts', source.provider);
  if (
    path.isAbsolute(source.sourceId)
    || source.sourceId.split(/[\\/]/u).includes('..')
  ) {
    throw new Error('transcript source id escapes its provider root');
  }
  const resolved = path.resolve(providerRoot, source.sourceId);
  const relative = path.relative(providerRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('transcript source id escapes its provider root');
  }
  return resolved;
}

class RawTranscriptSource implements TranscriptSourceAdapter {
  private readonly root: string;

  constructor(private readonly options: RawTranscriptSourceOptions) {
    this.root = path.resolve(options.root);
  }

  async sources(): Promise<readonly TranscriptSource[]> {
    const sources: TranscriptSource[] = [];
    for (const provider of ProviderName.options) {
      const providerRoot = path.join(this.root, 'transcripts', provider);
      for (const sourceId of await filesBelow(providerRoot)) {
        sources.push({ provider, sourceId });
      }
    }
    return sources;
  }

  async *read(
    source: TranscriptSource,
    fromOffset: number,
  ): AsyncIterable<TranscriptSourceItem> {
    const file = sourcePath(this.root, source);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('transcript source is not a regular file');
    }
    let buffered = Buffer.alloc(0);
    let cursor = fromOffset;
    for await (const chunk of createReadStream(file, { start: fromOffset })) {
      buffered = Buffer.concat([buffered, chunk as Buffer]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        let raw = buffered.subarray(0, newline);
        if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
        const nextOffset = cursor + newline + 1;
        yield normalizeProviderLine(
          source.provider,
          raw.toString('utf8'),
          cursor,
          nextOffset,
          this.options.resolveSessionRef,
        );
        buffered = buffered.subarray(newline + 1);
        cursor = nextOffset;
        newline = buffered.indexOf(0x0a);
      }
    }
    if (buffered.length > 0) {
      yield normalizeProviderLine(
        source.provider,
        buffered.toString('utf8'),
        cursor,
        cursor + buffered.length,
        this.options.resolveSessionRef,
      );
    }
  }
}

export function createRawTranscriptSource(
  options: RawTranscriptSourceOptions,
): TranscriptSourceAdapter {
  return new RawTranscriptSource(options);
}
