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

function claudeRole(
  row: Record<string, unknown>,
  declared: unknown,
  blockTypes: ReadonlySet<string | undefined>,
  hookBlock: boolean,
): TranscriptRole {
  const hook = row.type === "system" && (
    row.subtype === "hook_response" || "hookSpecificOutput" in row || hookBlock
  );
  if (hook) return "hook";
  if (blockTypes.has("tool_use")) return "tool_call";
  if (blockTypes.has("tool_result")) return "tool_result";
  if ([...blockTypes].some((type) =>
    type === "attachment" || type === "document" || type === "image")) {
    return "attachment";
  }
  return declaredRole(declared) ?? "system";
}

function structuredRole(role: TranscriptRole): boolean {
  return role === "tool_call"
    || role === "tool_result"
    || role === "attachment"
    || role === "hook";
}

/** Claude JSONL to the provider-neutral TranscriptLine vocabulary. */
export const claudeNormalizer: ProviderNormalizer = {
  provider: "claude",
  normalize(extent) {
    const row = parseExtent(extent);
    if (row === null) return noise();
    const agentIdentity = findAgentIdentityMarker(row);
    const resumeId = textValue(row.sessionId);
    if (agentIdentity !== undefined) {
      const turnId = textValue(row.uuid);
      const providerOccurredAt = textValue(row.timestamp);
      return {
        role: 'hook',
        text: JSON.stringify(agentIdentity),
        agentIdentity,
        ...(resumeId === undefined ? {} : { resumeId }),
        ...(turnId === undefined ? {} : { providerLineId: turnId, turnId }),
        ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
      };
    }
    if (!isObject(row.message)) return noise(resumeId);
    const message = row.message;
    const blocks = Array.isArray(message.content)
      ? message.content.filter(isObject)
      : [];
    const blockTypes = new Set(blocks.map((block) => textValue(block.type)));
    const role = claudeRole(
      row,
      message.role,
      blockTypes,
      blocks.some((block) => block.type === "hook_result"),
    );
    const normalizedText = structuredRole(role)
      ? jsonText(message.content)
      : contentText(message.content) ?? "";
    const text = role === 'user' ? displayUserText(normalizedText) : normalizedText;
    const turnId = textValue(row.uuid);
    const parentTurnId = textValue(row.parentUuid);
    const usage = numericUsage(message.usage);
    const providerOccurredAt = textValue(row.timestamp);
    return {
      role,
      text,
      ...(turnId === undefined ? {} : { providerLineId: turnId }),
      ...(resumeId === undefined ? {} : { resumeId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(parentTurnId === undefined ? {} : { parentTurnId }),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
      ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
      ...(role === "tool_call" && blocks[0] !== undefined
        ? { toolCall: blocks[0] } : {}),
    };
  },
};
