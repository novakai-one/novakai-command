import type { ProviderNormalizer } from "../../../contract/ports/provider-transcript-source.js";
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

function codexRole(
  rowType: unknown,
  eventType: string | undefined,
  declared: unknown,
  contentTypes: ReadonlySet<string | undefined>,
): TranscriptRole {
  if (rowType === "event_msg") {
    if (eventType === "user_message") return "user";
    if (eventType === "agent_message") return "assistant";
    return "system";
  }
  if (eventType === "function_call"
    || eventType === "custom_tool_call"
    || eventType === "web_search_call") return "tool_call";
  if (eventType === "function_call_output"
    || eventType === "custom_tool_call_output") return "tool_result";
  if ([...contentTypes].some((type) =>
    type === "input_image" || type === "input_file" || type === "attachment")) {
    return "attachment";
  }
  return declared === "developer" ? "system" : declaredRole(declared) ?? "system";
}

function codexText(
  role: TranscriptRole,
  eventType: string | undefined,
  payload: Record<string, unknown>,
): string {
  if (role === "tool_call") {
    return jsonText({ type: eventType, name: payload.name, arguments: payload.arguments });
  }
  if (role === "tool_result") return jsonText({ type: eventType, output: payload.output });
  if (role === "attachment") return jsonText(payload.content);
  return contentText(payload.content) ?? textValue(payload.message) ?? "";
}

/** Codex rollout JSONL to the provider-neutral TranscriptLine vocabulary. */
export const codexNormalizer: ProviderNormalizer = {
  provider: "codex",
  normalize(extent, turnIndex) {
    const row = parseExtent(extent);
    if (row === null) return noise();
    const agentIdentity = findAgentIdentityMarker(row);
    const payload = isObject(row.payload) ? row.payload : undefined;
    if (row.type === "session_meta") {
      return noise(textValue(payload?.id));
    }
    if (payload === undefined) return noise();
    const eventType = textValue(payload.type);
    const content = Array.isArray(payload.content)
      ? payload.content.filter(isObject)
      : [];
    const contentTypes = new Set(content.map((part) => textValue(part.type)));
    const role = agentIdentity === undefined
      ? codexRole(row.type, eventType, payload.role, contentTypes)
      : "hook";
    const normalizedText = codexText(role, eventType, payload);
    const text = role === 'user' ? displayUserText(normalizedText) : normalizedText;
    const metadata = isObject(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = textValue(payload.turn_id)
      ?? textValue(metadata?.turn_id)
      ?? textValue(payload.id)
      ?? `codex-turn-${turnIndex}`;
    const usage = numericUsage(payload.usage);
    const providerOccurredAt = textValue(row.timestamp);
    const providerLineId = textValue(payload.id)
      ?? (textValue(payload.call_id) === undefined
        ? undefined
        : `${textValue(row.type) ?? "row"}:${eventType ?? "event"}:${textValue(payload.call_id)}`);
    return {
      role,
      text,
      turnId,
      ...(providerLineId === undefined ? {} : { providerLineId }),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
      ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
      ...(role === "tool_call" ? { toolCall: payload } : {}),
      ...(agentIdentity === undefined ? {} : { agentIdentity }),
    };
  },
};
