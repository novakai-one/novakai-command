/**
 * NVK-KIMI-075 scratch probe (NOT a test row; `.mts`, excluded from the suite glob).
 *
 * Measures the parser against REAL Claude Code transcripts on this machine:
 * for every genuine human turn in each session file, submit that turn's own input
 * digest with the previous turn's completion as the start watermark, then count how
 * many turns the parser can prove.
 *
 *   npx tsx b3/tests/real-claude-boundary-probe.mts [fileLimit]
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  deterministicId, mintProviderSessionId, mintProviderTurnId,
  type TranscriptBindingId,
} from '@novakai/foundation/contract';
import {
  boundaryProfile, observeProviderBoundarySource,
} from '../contract/index.js';

const ROOT = path.join(
  process.env.HOME!, '.claude', 'projects', '-Users-christopherdasca-Programming-Novakai-Command',
);
const LIMIT = Number(process.argv[2] ?? '20');
const profile = boundaryProfile('claude', '2.1.219 (Claude Code)');
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const position = (ordinal: number): string => String(ordinal).padStart(10, '0');

const logicalText = (parts: unknown): string | null => {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.flatMap((part) => {
    const item = part as Record<string, unknown> | null;
    if (item === null || typeof item !== 'object') return [];
    if (item.type !== 'text' && item.type !== 'input_text') return [];
    return typeof item.text === 'string' ? [item.text] : [];
  }).join('');
  return text === '' ? null : text;
};

const isHumanTurn = (row: any): boolean => {
  if (row?.type !== 'user' || row.message?.role !== 'user') return false;
  const content = row.message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content)
    && !content.some((part: any) => part?.type === 'tool_result');
};

const tally: Record<string, number> = {};
let files = 0;
let turns = 0;

for (const entry of readdirSync(ROOT).filter((name) => name.endsWith('.jsonl')).slice(0, LIMIT)) {
  const full = path.join(ROOT, entry);
  const contents = readFileSync(full, 'utf8');
  const lines = contents.split('\n');
  const rows = lines.map((raw) => {
    try { return raw.trim() === '' ? null : JSON.parse(raw); } catch { return null; }
  });
  const sessionId = rows.find((row) => typeof row?.sessionId === 'string')?.sessionId as string | undefined;
  if (sessionId === undefined) continue;
  files += 1;
  const current = position(lines.length - 1);
  let watermark: string | null = null;
  for (const [ordinal, row] of rows.entries()) {
    if (!isHumanTurn(row)) continue;
    const text = logicalText(row.message.content);
    if (text === null) continue;
    turns += 1;
    const observation = observeProviderBoundarySource(profile, {
      providerSessionId: mintProviderSessionId(),
      providerNativeSessionId: sessionId,
      transcriptBindingId: deterministicId('transcriptBinding', [entry]) as TranscriptBindingId,
      providerTurnId: mintProviderTurnId(),
      inputDigest: sha256(text),
      startTranscriptWatermark: watermark,
      currentTranscriptWatermark: current,
    }, contents);
    const key = observation.kind === 'proven'
      ? 'proven'
      : `${observation.kind}/${'reason' in observation ? observation.reason : ''}`;
    tally[key] = (tally[key] ?? 0) + 1;
    if (observation.kind === 'proven') {
      watermark = observation.resultingWatermark;
    } else {
      watermark = position(ordinal);
    }
  }
}

const proven = tally.proven ?? 0;
console.log(`files ${files} · human turns ${turns}`);
console.log(`proven ${proven} (${(proven / turns * 100).toFixed(1)}%)`);
for (const [key, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${key}`);
}
