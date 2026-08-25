import type {
  NormalizedProviderLine,
  ProviderNormalizer,
} from "../../../contract/ports/provider-transcript-source.js";
import type { TranscriptRole } from "../../../contract/types.js";
import { normalizerSupport } from "./support.js";
import { findAgentIdentityMarker } from "../../../contract/agent-identity.js";

const {
  contentText,
  declaredRole,
  displayUserText,
  isObject,
  jsonText,
  noise,
  numericUsage,
  parseExtent,
  textValue,
} = normalizerSupport;

function messageLine(message: Record<string, unknown>): NormalizedProviderLine {
  const providerLineId = textValue(message.id);
  const role = declaredRole(message.role) ?? "system";
  const normalizedText = contentText(message.content) ?? jsonText(message.content);
  return {
    role,
    text: role === 'user' ? displayUserText(normalizedText) : normalizedText,
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
  const eventType = textValue(event.type);
  const part = isObject(event.part) ? event.part : undefined;
  const role = wireRole(eventType, part?.type);
  const text = role === "tool_call"
    ? jsonText({ name: event.name, args: event.args })
    : role === "tool_result"
      ? jsonText(event.result)
      : textValue(part?.text) ?? textValue(part?.think) ?? "";
  const usage = numericUsage(event.usage);
  const providerLineId = textValue(event.uuid);
  const turnId = textValue(event.turnId);
  return {
    role,
    text,
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
  return declaredRole(message?.role) ?? "assistant";
}

function nativeText(
  role: TranscriptRole,
  payload: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): string {
  if (role === "tool_call") return jsonText({ name: payload.name, args: payload.args });
  if (role === "tool_result") return textValue(payload.output) ?? jsonText(payload.message);
  if (role === "attachment") return jsonText(message?.content ?? payload);
  return textValue(payload.output)
    ?? textValue(payload.prompt)
    ?? contentText(message?.content)
    ?? textValue(message?.content)
    ?? "";
}

function nativeEventLine(
  envelope: Record<string, unknown>,
  turnIndex: number,
): NormalizedProviderLine {
  const payload = isObject(envelope.payload) ? envelope.payload : undefined;
  if (payload === undefined) return noise();
  const eventType = textValue(envelope.type) ?? textValue(payload.type);
  const message = isObject(payload.message) ? payload.message : undefined;
  const role = nativeRole(eventType, message);
  const seq = Number.isInteger(envelope.seq) ? Number(envelope.seq) : turnIndex;
  const resumeId = textValue(payload.sessionId) ?? textValue(envelope.session_id);
  const usage = numericUsage(payload.usage);
  const providerLineId = textValue(envelope.id);
  const parentTurnId = textValue(payload.parentTurnId);
  return {
    role,
    text: nativeText(role, payload, message),
    ...(providerLineId === undefined ? {} : { providerLineId }),
    ...(resumeId === undefined ? {} : { resumeId }),
    turnId: textValue(payload.turnId) ?? `kimi-turn-${seq}`,
    ...(parentTurnId === undefined ? {} : { parentTurnId }),
    ...(usage === undefined ? {} : { tokenUsage: usage }),
    ...(role === "tool_call" ? { toolCall: payload } : {}),
  };
}

/** Kimi wire/event JSONL to the provider-neutral TranscriptLine vocabulary. */
export const kimiNormalizer: ProviderNormalizer = {
  provider: "kimi",
  normalize(extent, turnIndex) {
    const row = parseExtent(extent);
    if (row === null) return noise();
    const agentIdentity = findAgentIdentityMarker(row);
    if (agentIdentity !== undefined) {
      return {
        role: "hook",
        text: JSON.stringify(agentIdentity),
        agentIdentity,
      };
    }
    if (isObject(row.message)) return messageLine(row.message);
    if (row.input !== undefined) return { role: "user", text: jsonText(row.input) };
    if (row.type === "context.append_loop_event" && isObject(row.event)) {
      return wireEventLine(row.event);
    }
    return row.kind === "event" && isObject(row.envelope)
      ? nativeEventLine(row.envelope, turnIndex)
      : noise();
  },
};
