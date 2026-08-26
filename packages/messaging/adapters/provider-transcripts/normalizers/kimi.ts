import type {
  NormalizedProviderLine,
  ProviderNormalizer,
} from "../../../contract/ports/provider-transcript-source.js";
import type { TranscriptRole } from "../../../contract/types.js";
import { normalizerSupport } from "./support.js";
import { findAgentIdentityMarker } from "../../../contract/agent-identity.js";
import { messageCorrelationHint } from '../../../contract/correlation.js';

const support = normalizerSupport;

function messageLine(message: Record<string, unknown>): NormalizedProviderLine {
  const providerLineId = support.textValue(message.id);
  const role = support.declaredRole(message.role) ?? "system";
  const normalizedText = support.contentText(message.content) ?? support.jsonText(message.content);
  const origin = support.isObject(message.origin) ? message.origin : undefined;
  const conversationRole = role === 'assistant'
    || (role === 'user' && support.textValue(origin?.kind) === 'user');
  const audience = conversationRole && normalizedText.trim() !== ''
    ? 'conversation'
    : 'internal';
  const text = role === 'user' ? support.displayUserText(normalizedText) : normalizedText;
  return {
    role,
    text,
    audience,
    ...(role === 'user' && audience === 'conversation'
      ? { correlationHint: messageCorrelationHint(text) } : {}),
    ...(providerLineId === undefined ? {} : { providerLineId }),
  };
}

function wireRole(eventType: string | undefined, partType: unknown): TranscriptRole {
  if (eventType === "tool.call") return "tool_call";
  if (eventType === "tool.result") return "tool_result";
  if (eventType === "content.part" && partType === "text") return "assistant";
  return "system";
}

function wireEventLine(event: Record<string, unknown>): NormalizedProviderLine {
  const eventType = support.textValue(event.type);
  const part = support.isObject(event.part) ? event.part : undefined;
  const role = wireRole(eventType, part?.type);
  const text = role === "tool_call"
    ? support.jsonText({ name: event.name, args: event.args })
    : role === "tool_result"
      ? support.jsonText(event.result)
      : support.textValue(part?.text) ?? support.textValue(part?.think) ?? "";
  const usage = support.numericUsage(event.usage);
  const providerLineId = support.textValue(event.uuid);
  const turnId = support.textValue(event.turnId);
  return {
    role,
    text,
    audience: role === 'assistant' && text.trim() !== '' ? 'conversation' : 'internal',
    ...(providerLineId === undefined ? {} : { providerLineId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(usage === undefined ? {} : { tokenUsage: usage }),
    ...(role === "tool_call" ? { toolCall: event } : {}),
  };
}

function nativeRole(
  eventType: string | undefined,
  message: Record<string, unknown> | undefined,
): TranscriptRole {
  if (eventType === "tool.call.started") return "tool_call";
  if (eventType === "tool.result") return "tool_result";
  if (eventType === "attachment") return "attachment";
  return support.declaredRole(message?.role) ?? "assistant";
}

function nativeText(
  role: TranscriptRole,
  payload: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): string {
  if (role === "tool_call") return support.jsonText({ name: payload.name, args: payload.args });
  if (role === "tool_result") return support.textValue(payload.output) ?? support.jsonText(payload.message);
  if (role === "attachment") return support.jsonText(message?.content ?? payload);
  return support.textValue(payload.output)
    ?? support.textValue(payload.prompt)
    ?? support.contentText(message?.content)
    ?? support.textValue(message?.content)
    ?? "";
}

function nativeEventLine(
  envelope: Record<string, unknown>,
  turnIndex: number,
): NormalizedProviderLine {
  const payload = support.isObject(envelope.payload) ? envelope.payload : undefined;
  if (payload === undefined) return support.noise();
  const eventType = support.textValue(envelope.type) ?? support.textValue(payload.type);
  const message = support.isObject(payload.message) ? payload.message : undefined;
  const role = nativeRole(eventType, message);
  const seq = Number.isInteger(envelope.seq) ? Number(envelope.seq) : turnIndex;
  const resumeId = support.textValue(payload.sessionId) ?? support.textValue(envelope.session_id);
  const usage = support.numericUsage(payload.usage);
  const providerLineId = support.textValue(envelope.id);
  const parentTurnId = support.textValue(payload.parentTurnId);
  const text = nativeText(role, payload, message);
  const audience = message?.role === 'user' || message?.role === 'assistant'
    ? 'conversation' : 'internal';
  return {
    role,
    text,
    audience,
    ...(role === 'user' && audience === 'conversation'
      ? { correlationHint: messageCorrelationHint(text) } : {}),
    ...(providerLineId === undefined ? {} : { providerLineId }),
    ...(resumeId === undefined ? {} : { resumeId }),
    turnId: support.textValue(payload.turnId) ?? `kimi-turn-${seq}`,
    ...(parentTurnId === undefined ? {} : { parentTurnId }),
    ...(usage === undefined ? {} : { tokenUsage: usage }),
    ...(role === "tool_call" ? { toolCall: payload } : {}),
  };
}

/** Kimi wire/event JSONL to the provider-neutral TranscriptLine vocabulary. */
export const kimiNormalizer: ProviderNormalizer = {
  provider: "kimi",
  normalize(extent, turnIndex) {
    const row = support.parseExtent(extent);
    if (row === null) return support.noise();
    const agentIdentity = findAgentIdentityMarker(row);
    if (agentIdentity !== undefined) {
      return {
        role: "hook",
        text: JSON.stringify(agentIdentity),
        audience: "internal",
        agentIdentity,
      };
    }
    if (support.isObject(row.message)) return messageLine(row.message);
    if (row.input !== undefined) {
      return { role: "user", text: support.jsonText(row.input), audience: 'internal' };
    }
    if (row.type === "context.append_loop_event" && support.isObject(row.event)) {
      return wireEventLine(row.event);
    }
    return row.kind === "event" && support.isObject(row.envelope)
      ? nativeEventLine(row.envelope, turnIndex)
      : support.noise();
  },
};
