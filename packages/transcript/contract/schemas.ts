import { z } from 'zod';
import {
  Envelope,
  SourceAttribution,
} from '@novakai/foundation/dist/contract/schemas.js';

export const ProviderName = z.enum(['kimi', 'claude', 'codex']);
export type ProviderName = z.infer<typeof ProviderName>;

export const SessionRef = z.string().min(1).brand<'ProviderSessionRef'>();
export type SessionRef = z.infer<typeof SessionRef>;

export const TranscriptRole = z.enum([
  'user',
  'assistant',
  'system',
  'tool',
]);
export type TranscriptRole = z.infer<typeof TranscriptRole>;

export const TokenUsage = z.record(z.number().int().nonnegative());
export type TokenUsage = z.infer<typeof TokenUsage>;

export const NormalizedTranscriptLine = z.object({
  nativeId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  turnIndex: z.number().int().nonnegative(),
  role: TranscriptRole,
  text: z.string(),
  tokenUsage: TokenUsage.optional(),
  agentId: z.string().min(1).optional(),
  parentAgentId: z.string().min(1).optional(),
  parentTurnId: z.string().min(1).optional(),
  sessionRef: SessionRef.optional(),
}).strict();
export type NormalizedTranscriptLine = z.infer<typeof NormalizedTranscriptLine>;

export const TranscriptSource = z.object({
  provider: ProviderName,
  sourceId: z.string().min(1),
}).strict();
export type TranscriptSource = z.infer<typeof TranscriptSource>;

const OpaqueRelationKey = z.string().regex(/^relation_[a-f0-9]{64}$/);

export const TranscriptRelationDelta = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('parent'),
    parentKey: OpaqueRelationKey,
    parentTurnId: z.string().min(1),
    remainingChildren: z.number().int().positive(),
    parentAgentId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    type: z.literal('child'),
    childKey: OpaqueRelationKey,
    parentKey: OpaqueRelationKey,
    agentId: z.string().min(1).optional(),
  }).strict(),
]);
export type TranscriptRelationDelta = z.infer<
  typeof TranscriptRelationDelta
>;

export const TranscriptRelationState = z.object({
  parents: z.record(OpaqueRelationKey, z.object({
    parentTurnId: z.string().min(1),
    remainingChildren: z.number().int().positive(),
    parentAgentId: z.string().min(1).optional(),
  }).strict()),
  children: z.record(OpaqueRelationKey, z.object({
    parentTurnId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    parentAgentId: z.string().min(1).optional(),
  }).strict()),
}).strict();
export type TranscriptRelationState = z.infer<
  typeof TranscriptRelationState
>;

const SourcePosition = z.object({
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().positive(),
});

export const TranscriptSkipReason = z.object({
  code: z.enum([
    'malformed_json',
    'unsupported_shape',
  ]),
  message: z.string().min(1),
}).strict();
export type TranscriptSkipReason = z.infer<typeof TranscriptSkipReason>;

export const TranscriptDiagnostic = z.object({
  code: z.enum([
    'session_ref_unresolved',
    'agent_attribution_unavailable',
  ]),
  message: z.string().min(1),
}).strict();
export type TranscriptDiagnostic = z.infer<typeof TranscriptDiagnostic>;

export const TranscriptSourceCandidate = SourcePosition.extend({
  kind: z.literal('candidate'),
  content: z.string(),
  line: NormalizedTranscriptLine,
  diagnostics: z.array(TranscriptDiagnostic).optional(),
}).superRefine((item, context) => {
  if (item.nextOffset <= item.offset) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextOffset'],
      message: 'nextOffset must be greater than offset',
    });
  }
});
export type TranscriptSourceCandidate = z.infer<
  typeof TranscriptSourceCandidate
>;

export const TranscriptSourceSkip = SourcePosition.extend({
  kind: z.literal('skip'),
  reason: TranscriptSkipReason,
}).superRefine((item, context) => {
  if (item.nextOffset <= item.offset) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextOffset'],
      message: 'nextOffset must be greater than offset',
    });
  }
});
export type TranscriptSourceSkip = z.infer<typeof TranscriptSourceSkip>;

export const TranscriptSourceContext = SourcePosition.extend({
  kind: z.literal('context'),
  relation: TranscriptRelationDelta.optional(),
}).superRefine((item, context) => {
  if (item.nextOffset <= item.offset) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextOffset'],
      message: 'nextOffset must be greater than offset',
    });
  }
});
export type TranscriptSourceContext = z.infer<
  typeof TranscriptSourceContext
>;

export const TranscriptSourceItem = z.union([
  TranscriptSourceCandidate,
  TranscriptSourceSkip,
  TranscriptSourceContext,
]);
export type TranscriptSourceItem = z.infer<typeof TranscriptSourceItem>;

export const TranscriptLine = Envelope.extend({
  kind: z.literal('transcriptLine'),
  id: z.string().regex(/^transcriptLine_[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
  permissionLevel: z.literal('private'),
  sourceAttribution: SourceAttribution,
  provider: ProviderName,
  sourceId: z.string().min(1),
  sourceOffset: z.number().int().nonnegative(),
  dedupKey: z.string().min(1),
  turnId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  role: TranscriptRole,
  text: z.string(),
  tokenUsage: TokenUsage.optional(),
  agentId: z.string().min(1).optional(),
  parentAgentId: z.string().min(1).optional(),
  parentTurnId: z.string().min(1).optional(),
  sessionRef: SessionRef.optional(),
});
export type TranscriptLine = z.infer<typeof TranscriptLine>;

const TranscriptJournalBase = Envelope.extend({
  kind: z.literal('transcriptJournal'),
  id: z.string().regex(/^transcriptJournal_[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
  permissionLevel: z.literal('private'),
  provider: ProviderName,
  sourceId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().positive(),
});

export const TranscriptSkipJournalEntry = TranscriptJournalBase.extend({
  outcome: z.literal('skipped'),
  skip: TranscriptSkipReason,
});
export type TranscriptSkipJournalEntry = z.infer<
  typeof TranscriptSkipJournalEntry
>;

export const TranscriptDiagnosticJournalEntry = TranscriptJournalBase.extend({
  outcome: z.literal('diagnostic'),
  diagnostic: TranscriptDiagnostic,
});
export type TranscriptDiagnosticJournalEntry = z.infer<
  typeof TranscriptDiagnosticJournalEntry
>;

export const TranscriptRelationJournalEntry = TranscriptJournalBase.extend({
  outcome: z.literal('relation'),
  relation: TranscriptRelationDelta,
});
export type TranscriptRelationJournalEntry = z.infer<
  typeof TranscriptRelationJournalEntry
>;

export const TranscriptJournalEntry = z.discriminatedUnion('outcome', [
  TranscriptSkipJournalEntry,
  TranscriptDiagnosticJournalEntry,
  TranscriptRelationJournalEntry,
]);
export type TranscriptJournalEntry = z.infer<
  typeof TranscriptJournalEntry
>;

export const TranscriptCheckpoint = Envelope.extend({
  kind: z.literal('transcriptCheckpoint'),
  id: z.string().regex(/^transcriptCheckpoint_[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
  permissionLevel: z.literal('private'),
  provider: ProviderName,
  sourceId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type TranscriptCheckpoint = z.infer<typeof TranscriptCheckpoint>;

export interface IngestResult {
  added: number;
  duplicates: number;
  skipped: TranscriptSkipJournalEntry[];
  diagnostics: TranscriptDiagnosticJournalEntry[];
}
