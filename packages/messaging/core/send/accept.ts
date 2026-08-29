import type {
  ConversationSendInput,
  SendRejection,
} from '../../contract/commands.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { Timestamp } from '../../contract/types.js';
import { parseConversationId } from '../../contract/conversation-id.js';
import type { AgentLookup } from './agent-lookup.js';
import { mintRequestHash, mintSendId } from './mint.js';
import { present } from './sparse.js';
import type { SendStore } from './send-store.js';

interface AcceptDependencies {
  readonly store: SendStore;
  readonly agentDirectory: AgentLookup;
  readonly now: () => Timestamp;
}

/** Journaled acceptance, or the typed reason the request was refused before any write. */
export type AcceptSendOutcome =
  | { readonly ok: true; readonly journal: SendJournal; readonly duplicate: boolean }
  | { readonly ok: false; readonly rejection: SendRejection };

type InvalidSendField = Extract<SendRejection, { code: 'invalid-send-input' }>['field'];

const CLIENT_OP_ID_LIMIT = 128;
const TEXT_BYTE_LIMIT = 32_768;

/** One declarative input requirement; the checklist a reader audits instead of guard-clause soup. */
interface SendRule {
  readonly field: InvalidSendField;
  readonly requirement: string;
  readonly fails: (input: ConversationSendInput) => boolean;
}

const SEND_RULES: readonly SendRule[] = [
  {
    field: 'issuedBy',
    requirement: 'a non-empty issuedBy',
    fails: (input) => input.issuedBy.length === 0,
  },
  {
    field: 'targetAgentId',
    requirement: 'a non-empty targetAgentId',
    fails: (input) => input.targetAgentId.length === 0,
  },
  {
    field: 'clientOpId',
    requirement: `a clientOpId of 1..${CLIENT_OP_ID_LIMIT} characters`,
    fails: (input) =>
      input.clientOpId.length === 0 || input.clientOpId.length > CLIENT_OP_ID_LIMIT,
  },
  {
    field: 'text',
    requirement: `message text of 1..${TEXT_BYTE_LIMIT} UTF-8 bytes`,
    fails: (input) =>
      input.text.trim().length === 0 || Buffer.byteLength(input.text, 'utf8') > TEXT_BYTE_LIMIT,
  },
];

function firstViolation(input: ConversationSendInput): SendRejection | undefined {
  const rule = SEND_RULES.find((candidate) => candidate.fails(input));
  if (rule === undefined) return undefined;
  return {
    code: 'invalid-send-input',
    field: rule.field,
    message: `Conversation send requires ${rule.requirement}`,
  };
}

function unknownAgent(targetAgentId: string): AcceptSendOutcome {
  return {
    ok: false,
    rejection: {
      code: 'unknown-target-agent',
      targetAgentId,
      message: `Unknown target Agent ${targetAgentId}`,
    },
  };
}

/**
 * Validates one send request and durably records it as an accepted send
 * journal. The journal lands before the provider is ever touched, so a
 * retried request — same issuer, same clientOpId — returns the original
 * record instead of sending the message twice. Bad input and unknown Agents
 * come back as typed rejections; nothing is written for either.
 */
export async function acceptSend(
  dependencies: AcceptDependencies,
  input: ConversationSendInput,
): Promise<AcceptSendOutcome> {
  const conversationId = parseConversationId(input.conversationId);
  if (conversationId === undefined) {
    return {
      ok: false,
      rejection: {
        code: 'invalid-send-input',
        field: 'conversationId',
        message: 'Conversation send requires a valid conversationId',
      },
    };
  }
  const violation = firstViolation(input);
  if (violation !== undefined) return { ok: false, rejection: violation };
  const agent = await dependencies.agentDirectory.get(input.targetAgentId);
  if (agent === null) return unknownAgent(input.targetAgentId);
  const request = { text: input.text, ...present('screenContext', input.screenContext) };
  const timestamp = dependencies.now();
  const stored = await dependencies.store.acceptSend({
    journal: {
      id: mintSendId(input.issuedBy, input.clientOpId),
      kind: 'send-journal',
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      conversationId,
      issuedBy: input.issuedBy,
      targetAgentId: input.targetAgentId,
      clientOpId: input.clientOpId,
      request,
      requestHash: mintRequestHash({
        conversationId: input.conversationId,
        issuedBy: input.issuedBy,
        targetAgentId: input.targetAgentId,
        request,
      }),
      state: 'accepted',
      attempts: [],
      ...present('targetSessionId', agent.currentProviderSessionId ?? undefined),
    },
  });
  return { ok: true, journal: stored.journal, duplicate: stored.duplicate };
}
