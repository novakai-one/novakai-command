/**
 * Input validation — MSG-021: all external input is parsed from `unknown` at
 * the door. Parsers are hand-written against the shapes in
 * contract/messaging-contract.json (zero runtime deps); every rejection is a
 * typed ValidationFailed carrying {path, message} issues — never a throw.
 *
 * Schemas are `additionalProperties: false` throughout the contract source, so
 * unknown keys are rejected — this is also the MSG-020 proof: a caller-supplied
 * `from`/`senderId` fails the door parse (sender identity comes from
 * authentication only, DEC-11).
 */

import {
  contactPolicyDefaultRuleValues,
  idPatterns,
  messageBodyFormatValues,
  priorityValues,
  subscribeInputEventsValues,
  transportKindValues,
} from "../public/contract/index.js";
import { MessagingError } from "../public/contract/index.js";
import type {
  Address,
  ClientMessageId,
  Cursor,
  MessageId,
  PersonId,
  PresenceId,
  ThreadId,
  TransportKind,
  ValidationIssue,
} from "../public/contract/index.js";
import type {
  ClosePresenceInput,
  ListThreadsForPersonInput,
  OpenPresenceInput,
  SendMessageInput,
  SetContactPolicyInput,
  SetDndPolicyInput,
  SubscribeInput,
  SubscribeInputEvents,
} from "../public/contract/index.js";
import type { MessageBody } from "../public/contract/index.js";
import type {
  GetDeliveryInput,
  GetInboxInput,
  GetMessagesInput,
  GetPolicyInput,
  GetPresenceInput,
  GetThreadInput,
} from "../public/contract/index.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: MessagingError };

function validationFailed(issues: ValidationIssue[]): MessagingError {
  return new MessagingError("ValidationFailed", {
    message: `validation failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    retryable: false,
    fields: { issues },
  });
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

// --- primitives ---------------------------------------------------------------

type Reader<T> = (value: unknown, path: string) => { value?: T; issue?: ValidationIssue };

function readString(value: unknown, path: string): { value?: string; issue?: ValidationIssue } {
  if (typeof value !== "string") return { issue: issue(path, "expected string") };
  return { value };
}

function readBoolean(value: unknown, path: string): { value?: boolean; issue?: ValidationIssue } {
  if (typeof value !== "boolean") return { issue: issue(path, "expected boolean") };
  return { value };
}

function readPattern<T extends string>(pattern: RegExp, label: string): Reader<T> {
  return (value, path) => {
    if (typeof value !== "string" || !pattern.test(value)) {
      return { issue: issue(path, `expected ${label}`) };
    }
    return { value: value as T };
  };
}

function readEnum<T extends string>(values: readonly T[], label: string): Reader<T> {
  return (value, path) => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      return { issue: issue(path, `expected one of ${label}`) };
    }
    return { value: value as T };
  };
}

function readLimit(value: unknown, path: string): { value?: number; issue?: ValidationIssue } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { issue: issue(path, "expected integer >= 1") };
  }
  return { value };
}

const readAddress = readPattern<Address>(new RegExp(idPatterns.Address), "Address (person:person_… | thread:thread_…)");
const readPersonId = readPattern<PersonId>(new RegExp(idPatterns.PersonId), "PersonId (person_…)");
const readPresenceId = readPattern<PresenceId>(new RegExp(idPatterns.PresenceId), "PresenceId (presence_…)");
const readThreadId = readPattern<ThreadId>(new RegExp(idPatterns.ThreadId), "ThreadId (thread_…)");
const readMessageId = readPattern<MessageId>(new RegExp(idPatterns.MessageId), "MessageId (message_…)");
const readCursor = readPattern<Cursor>(new RegExp(idPatterns.Cursor), "cursor (s_<n>)");
const readTransport = readEnum<TransportKind>(transportKindValues, transportKindValues.join(" | "));
const readPriority = readEnum(priorityValues, priorityValues.join(" | "));
const readBodyFormat = readEnum(messageBodyFormatValues, messageBodyFormatValues.join(" | "));
const readDefaultRule = readEnum(contactPolicyDefaultRuleValues, contactPolicyDefaultRuleValues.join(" | "));

function readClientMessageId(value: unknown, path: string): { value?: ClientMessageId; issue?: ValidationIssue } {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    return { issue: issue(path, "expected string of length 1..128") };
  }
  return { value: value as ClientMessageId };
}

function readMessageBody(value: unknown, path: string): { value?: MessageBody; issue?: ValidationIssue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issue: issue(path, "expected object") };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !["text", "format", "subject", "fields"].includes(key));
  if (unknownKeys.length > 0) {
    return { issue: issue(path, `unknown keys: ${unknownKeys.join(", ")}`) };
  }
  if (typeof record["text"] !== "string" || record["text"].length < 1) {
    return { issue: issue(`${path}.text`, "expected string of length >= 1") };
  }
  const body: MessageBody = { text: record["text"] };
  if (record["format"] !== undefined) {
    const format = readBodyFormat(record["format"], `${path}.format`);
    if (format.issue) return { issue: format.issue };
    if (format.value !== undefined) body.format = format.value;
  }
  if (record["subject"] !== undefined) {
    if (typeof record["subject"] !== "string") {
      return { issue: issue(`${path}.subject`, "expected string") };
    }
    body.subject = record["subject"];
  }
  if (record["fields"] !== undefined) {
    if (typeof record["fields"] !== "object" || record["fields"] === null || Array.isArray(record["fields"])) {
      return { issue: issue(`${path}.fields`, "expected object") };
    }
    body.fields = record["fields"] as Record<string, unknown>;
  }
  return { value: body };
}

// --- object-frame helper --------------------------------------------------------

/**
 * Reads an object frame with a closed key set. Returns undefined issues-free
 * only when the frame and every REQUIRED key parse; per-key readers collect
 * into `issues`.
 */
function frame(
  input: unknown,
  allowedKeys: readonly string[],
): { record?: Record<string, unknown>; issues: ValidationIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { issues: [issue("$", "expected object")] };
  }
  const record = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      issues.push(issue(key, "unknown key (additionalProperties: false)"));
    }
  }
  return { record, issues };
}

function field<T>(
  record: Record<string, unknown>,
  key: string,
  reader: Reader<T>,
  issues: ValidationIssue[],
  required: boolean,
): T | undefined {
  const raw = record[key];
  if (raw === undefined) {
    if (required) issues.push(issue(key, "required"));
    return undefined;
  }
  const read = reader(raw, key);
  if (read.issue) {
    issues.push(read.issue);
    return undefined;
  }
  return read.value;
}

function finish<T>(issues: ValidationIssue[], build: () => T): ParseResult<T> {
  if (issues.length > 0) return { ok: false, error: validationFailed(issues) };
  return { ok: true, value: build() };
}

// --- command inputs -------------------------------------------------------------

export function parseSendMessageInput(input: unknown): ParseResult<SendMessageInput> {
  const { record, issues } = frame(input, ["address", "body", "priority", "clientMessageId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const address = field(record, "address", readAddress, issues, true);
  const body = field(record, "body", readMessageBody, issues, true);
  const priority = field(record, "priority", readPriority, issues, true);
  const clientMessageId = field(record, "clientMessageId", readClientMessageId, issues, true);
  return finish(issues, () => ({
    address: address as Address,
    body: body as MessageBody,
    priority: priority as SendMessageInput["priority"],
    clientMessageId: clientMessageId as ClientMessageId,
  }));
}

export function parseOpenPresenceInput(input: unknown): ParseResult<OpenPresenceInput> {
  const { record, issues } = frame(input, ["transport", "clientLabel"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const transport = field(record, "transport", readTransport, issues, true);
  const clientLabel = field(record, "clientLabel", readString, issues, false);
  return finish(issues, () => ({
    transport: transport as TransportKind,
    ...(clientLabel !== undefined ? { clientLabel } : {}),
  }));
}

export function parseClosePresenceInput(input: unknown): ParseResult<ClosePresenceInput> {
  const { record, issues } = frame(input, ["presenceId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const presenceId = field(record, "presenceId", readPresenceId, issues, true);
  return finish(issues, () => ({ presenceId: presenceId as PresenceId }));
}

export function parseSetDndPolicyInput(input: unknown): ParseResult<SetDndPolicyInput> {
  const { record, issues } = frame(input, ["personId", "enabled"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, false);
  const enabled = field(record, "enabled", readBoolean, issues, true);
  return finish(issues, () => ({
    ...(personId !== undefined ? { personId } : {}),
    enabled: enabled as boolean,
  }));
}

export function parseSetContactPolicyInput(input: unknown): ParseResult<SetContactPolicyInput> {
  const { record, issues } = frame(input, ["personId", "allowlist", "defaultRule"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, false);
  const defaultRule = field(record, "defaultRule", readDefaultRule, issues, true);
  let allowlist: PersonId[] | undefined;
  const rawAllowlist = record["allowlist"];
  if (rawAllowlist === undefined) {
    issues.push(issue("allowlist", "required"));
  } else if (!Array.isArray(rawAllowlist)) {
    issues.push(issue("allowlist", "expected array of PersonId"));
  } else {
    allowlist = [];
    const seen = new Set<string>();
    rawAllowlist.forEach((entry, index) => {
      const read = readPersonId(entry, `allowlist[${index}]`);
      if (read.issue) {
        issues.push(read.issue);
      } else if (seen.has(read.value as string)) {
        issues.push(issue(`allowlist[${index}]`, "duplicate entry (uniqueItems)"));
      } else {
        seen.add(read.value as string);
        allowlist?.push(read.value as PersonId);
      }
    });
  }
  return finish(issues, () => ({
    ...(personId !== undefined ? { personId } : {}),
    allowlist: allowlist as PersonId[],
    defaultRule: defaultRule as SetContactPolicyInput["defaultRule"],
  }));
}

// --- query inputs ---------------------------------------------------------------

export function parseGetThreadInput(input: unknown): ParseResult<GetThreadInput> {
  const { record, issues } = frame(input, ["threadId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const threadId = field(record, "threadId", readThreadId, issues, true);
  return finish(issues, () => ({ threadId: threadId as ThreadId }));
}

export function parseListThreadsForPersonInput(input: unknown): ParseResult<ListThreadsForPersonInput> {
  const { record, issues } = frame(input, ["personId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, false);
  return finish(issues, () => ({ ...(personId !== undefined ? { personId } : {}) }));
}

export function parseGetMessagesInput(input: unknown): ParseResult<GetMessagesInput> {
  const { record, issues } = frame(input, ["threadId", "cursor", "limit"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const threadId = field(record, "threadId", readThreadId, issues, true);
  const cursor = field(record, "cursor", readCursor, issues, false);
  const limit = field(record, "limit", readLimit, issues, false);
  return finish(issues, () => ({
    threadId: threadId as ThreadId,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }));
}

export function parseGetInboxInput(input: unknown): ParseResult<GetInboxInput> {
  const { record, issues } = frame(input, ["personId", "cursor", "limit"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, false);
  const cursor = field(record, "cursor", readCursor, issues, false);
  const limit = field(record, "limit", readLimit, issues, false);
  return finish(issues, () => ({
    ...(personId !== undefined ? { personId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }));
}

export function parseGetDeliveryInput(input: unknown): ParseResult<GetDeliveryInput> {
  const { record, issues } = frame(input, ["messageId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const messageId = field(record, "messageId", readMessageId, issues, true);
  return finish(issues, () => ({ messageId: messageId as MessageId }));
}

export function parseGetPolicyInput(input: unknown): ParseResult<GetPolicyInput> {
  const { record, issues } = frame(input, ["personId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, false);
  return finish(issues, () => ({ ...(personId !== undefined ? { personId } : {}) }));
}

export function parseGetPresenceInput(input: unknown): ParseResult<GetPresenceInput> {
  const { record, issues } = frame(input, ["personId"]);
  if (!record) return { ok: false, error: validationFailed(issues) };
  const personId = field(record, "personId", readPersonId, issues, true);
  return finish(issues, () => ({ personId: personId as PersonId }));
}

// --- subscription input (R1) ----------------------------------------------------

const readEventKind = readEnum<SubscribeInputEvents>(
  subscribeInputEventsValues,
  subscribeInputEventsValues.join(" | "),
);

export function parseSubscribeInput(input: unknown): ParseResult<SubscribeInput> {
  const { record, issues } = frame(input, ["events", "threads", "since"]);
  if (!record) return { ok: false, error: validationFailed(issues) };

  // events: required, minItems 1, uniqueItems, enum (contract $defs.SubscribeInput).
  let events: SubscribeInputEvents[] | undefined;
  const rawEvents = record["events"];
  if (rawEvents === undefined) {
    issues.push(issue("events", "required"));
  } else if (!Array.isArray(rawEvents) || rawEvents.length < 1) {
    issues.push(issue("events", "expected non-empty array of event kinds (minItems: 1)"));
  } else {
    events = [];
    const seen = new Set<string>();
    rawEvents.forEach((entry, index) => {
      const read = readEventKind(entry, `events[${index}]`);
      if (read.issue) {
        issues.push(read.issue);
      } else if (seen.has(read.value as string)) {
        issues.push(issue(`events[${index}]`, "duplicate entry (uniqueItems)"));
      } else {
        seen.add(read.value as string);
        events?.push(read.value as SubscribeInputEvents);
      }
    });
  }

  // threads: optional scope, unique ThreadIds.
  let threads: ThreadId[] | undefined;
  const rawThreads = record["threads"];
  if (rawThreads !== undefined) {
    if (!Array.isArray(rawThreads)) {
      issues.push(issue("threads", "expected array of ThreadId"));
    } else {
      threads = [];
      const seen = new Set<string>();
      rawThreads.forEach((entry, index) => {
        const read = readThreadId(entry, `threads[${index}]`);
        if (read.issue) {
          issues.push(read.issue);
        } else if (seen.has(read.value as string)) {
          issues.push(issue(`threads[${index}]`, "duplicate entry (uniqueItems)"));
        } else {
          seen.add(read.value as string);
          threads?.push(read.value as ThreadId);
        }
      });
    }
  }

  // since: optional resume cursor — malformed/foreign → ValidationFailed (R1).
  const since = field(record, "since", readCursor, issues, false);

  return finish(issues, () => ({
    events: events as SubscribeInputEvents[],
    ...(threads !== undefined ? { threads } : {}),
    ...(since !== undefined ? { since } : {}),
  }));
}
