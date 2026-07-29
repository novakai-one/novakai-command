import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ProviderName,
  SessionRef,
  type NormalizedTranscriptLine,
  type ProviderName as ProviderNameT,
  type SessionRef as SessionRefT,
  type TranscriptDiagnostic,
  type TranscriptSource,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import type { TranscriptSourceAdapter } from '../contract/source.js';

export type ProviderSessionResolver = (
  provider: ProviderNameT,
  nativeSessionId: string,
) => SessionRefT | undefined;

export interface RawTranscriptSourceOptions {
  /** The .novakai root containing recursive provider JSONL copies. */
  root: string;
  resolveSessionRef?: ProviderSessionResolver;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && Number(entry[1]) >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.content === 'string') return value.content;
  return undefined;
}

function diagnostic(
  code: TranscriptDiagnostic['code'],
  message: string,
): TranscriptDiagnostic {
  return { code, message };
}

function unsupported(
  offset: number,
  nextOffset: number,
  provider: ProviderNameT,
): TranscriptSourceItem {
  return {
    kind: 'skip',
    offset,
    nextOffset,
    reason: {
      code: 'unsupported_shape',
      message: `${provider} row does not expose a supported transcript message shape`,
    },
  };
}

function normalizeKimi(
  row: unknown,
  content: string,
  offset: number,
  nextOffset: number,
  resolver?: ProviderSessionResolver,
): TranscriptSourceItem {
  if (!isRecord(row) || row.kind !== 'event' || !isRecord(row.envelope)) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const envelope = row.envelope;
  if (
    !Number.isInteger(envelope.seq)
    || Number(envelope.seq) < 0
    || !isRecord(envelope.payload)
  ) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const payload = envelope.payload;
  const text = (
    stringValue(payload.output)
    ?? stringValue(payload.prompt)
    ?? messageText(payload.message)
  );
  if (text === undefined) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const message = isRecord(payload.message) ? payload.message : undefined;
  const explicitRole = stringValue(message?.role);
  const role = explicitRole === 'user'
    || explicitRole === 'assistant'
    || explicitRole === 'system'
    || explicitRole === 'tool'
    ? explicitRole
    : payload.prompt !== undefined
      ? 'user'
      : 'assistant';
  const nativeSessionId = (
    stringValue(payload.sessionId)
    ?? stringValue(envelope.session_id)
  );
  const resolvedSession = nativeSessionId && resolver
    ? SessionRef.safeParse(resolver('kimi', nativeSessionId))
    : undefined;
  const diagnostics: TranscriptDiagnostic[] = [];
  if (nativeSessionId && (!resolvedSession || !resolvedSession.success)) {
    diagnostics.push(diagnostic(
      'session_ref_unresolved',
      'provider-native session has no verified providerSession resolver',
    ));
  }
  const agentId = stringValue(payload.agentId);
  if (!agentId && stringValue(payload.subagentId)) {
    diagnostics.push(diagnostic(
      'agent_attribution_unavailable',
      'provider subagent identity is not a verified durable agent id',
    ));
  }
  const turnId = stringValue(payload.turnId);
  const line: NormalizedTranscriptLine = {
    ...(turnId ? { nativeId: turnId, turnId } : {}),
    turnIndex: Number(envelope.seq),
    role,
    text,
    ...(numericUsage(payload.usage)
      ? { tokenUsage: numericUsage(payload.usage) }
      : {}),
    ...(agentId ? { agentId } : {}),
    ...(stringValue(payload.parentAgentId)
      ? { parentAgentId: stringValue(payload.parentAgentId) }
      : {}),
    ...(stringValue(payload.parentToolCallId)
      ? { parentTurnId: stringValue(payload.parentToolCallId) }
      : {}),
    ...(resolvedSession?.success
      ? { sessionRef: resolvedSession.data }
      : {}),
  };
  return {
    kind: 'candidate',
    offset,
    nextOffset,
    content,
    line,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function normalizeLine(
  provider: ProviderNameT,
  content: string,
  offset: number,
  nextOffset: number,
  resolver?: ProviderSessionResolver,
): TranscriptSourceItem {
  let row: unknown;
  try {
    row = JSON.parse(content);
  } catch {
    return {
      kind: 'skip',
      offset,
      nextOffset,
      reason: {
        code: 'malformed_json',
        message: 'provider row is not valid JSON',
      },
    };
  }
  if (provider === 'kimi') {
    return normalizeKimi(row, content, offset, nextOffset, resolver);
  }
  return unsupported(offset, nextOffset, provider);
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
        yield normalizeLine(
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
      yield normalizeLine(
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
