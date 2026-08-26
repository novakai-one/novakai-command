import type { ProviderNormalizer } from "../../../contract/ports/provider-transcript-source.js";
import type { TranscriptRole } from "../../../contract/types.js";
import { normalizerSupport } from "./support.js";
import { findAgentIdentityMarker } from "../../../contract/agent-identity.js";
import { messageCorrelationHint } from '../../../contract/correlation.js';

const support = normalizerSupport;

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
  return declared === "developer" ? "system" : support.declaredRole(declared) ?? "system";
}

function codexText(
  role: TranscriptRole,
  eventType: string | undefined,
  payload: Record<string, unknown>,
): string {
  if (role === "tool_call") {
    return support.jsonText({ type: eventType, name: payload.name, arguments: payload.arguments });
  }
  if (role === "tool_result") return support.jsonText({ type: eventType, output: payload.output });
  if (role === "attachment") return support.jsonText(payload.content);
  return support.contentText(payload.content) ?? support.textValue(payload.message) ?? "";
}

function isHarnessContent(content: readonly Record<string, unknown>[]): boolean {
  const internalPrefixes = [
    '<recommended_plugins>',
    '# AGENTS.md instructions',
    '<environment_context>',
    '<app-context>',
    '<skills_instructions>',
    '<permissions instructions>',
    '<collaboration_mode>',
  ];
  return content.some((part) => {
    const text = support.textValue(part.text);
    return text !== undefined && internalPrefixes.some((prefix) => text.startsWith(prefix));
  });
}

/** Codex rollout JSONL to the provider-neutral TranscriptLine vocabulary. */
export const codexNormalizer: ProviderNormalizer = {
  provider: "codex",
  normalize(extent, turnIndex) {
    const row = support.parseExtent(extent);
    if (row === null) return support.noise();
    const agentIdentity = findAgentIdentityMarker(row);
    const payload = support.isObject(row.payload) ? row.payload : undefined;
    if (row.type === "session_meta") {
      return support.noise(support.textValue(payload?.id));
    }
    if (payload === undefined) return support.noise();
    const eventType = support.textValue(payload.type);
    const content = Array.isArray(payload.content)
      ? payload.content.filter(support.isObject)
      : [];
    const contentTypes = new Set(content.map((part) => support.textValue(part.type)));
    const role = agentIdentity === undefined
      ? codexRole(row.type, eventType, payload.role, contentTypes)
      : "hook";
    const normalizedText = codexText(role, eventType, payload);
    const text = role === 'user' ? support.displayUserText(normalizedText) : normalizedText;
    const metadata = support.isObject(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const audience = row.type === 'response_item'
      && eventType === 'message'
      && metadata !== undefined
      && (role === 'user' || role === 'assistant')
      && text.trim() !== ''
      && !isHarnessContent(content)
      ? 'conversation'
      : 'internal';
    const turnId = support.textValue(payload.turn_id)
      ?? support.textValue(metadata?.turn_id)
      ?? support.textValue(payload.id)
      ?? `codex-turn-${turnIndex}`;
    const usage = support.numericUsage(payload.usage);
    const providerOccurredAt = support.textValue(row.timestamp);
    const providerLineId = support.textValue(payload.id)
      ?? (support.textValue(payload.call_id) === undefined
        ? undefined
        : `${support.textValue(row.type) ?? "row"}:${eventType ?? "event"}:${support.textValue(payload.call_id)}`);
    return {
      role,
      text,
      audience,
      turnId,
      ...(providerLineId === undefined ? {} : { providerLineId }),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
      ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
      ...(role === 'user' && audience === 'conversation'
        ? { correlationHint: messageCorrelationHint(text) } : {}),
      ...(role === "tool_call" ? { toolCall: payload } : {}),
      ...(agentIdentity === undefined ? {} : { agentIdentity }),
    };
  },
};
