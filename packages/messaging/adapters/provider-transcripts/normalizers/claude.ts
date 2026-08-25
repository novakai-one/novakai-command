import type { ProviderNormalizer } from "../../../contract/ports/provider-transcript-source.js";
import type { TranscriptRole } from "../../../contract/types.js";
import { normalizerSupport } from "./support.js";
import { findAgentIdentityMarker } from "../../../contract/agent-identity.js";

const support = normalizerSupport;

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
  return support.declaredRole(declared) ?? "system";
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
    const row = support.parseExtent(extent);
    if (row === null) return support.noise();
    const agentIdentity = findAgentIdentityMarker(row);
    const resumeId = support.textValue(row.sessionId);
    if (agentIdentity !== undefined) {
      const turnId = support.textValue(row.uuid);
      const providerOccurredAt = support.textValue(row.timestamp);
      return {
        role: 'hook',
        text: JSON.stringify(agentIdentity),
        audience: 'internal',
        agentIdentity,
        ...(resumeId === undefined ? {} : { resumeId }),
        ...(turnId === undefined ? {} : { providerLineId: turnId, turnId }),
        ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
      };
    }
    if (!support.isObject(row.message)) return support.noise(resumeId);
    const message = row.message;
    const blocks = Array.isArray(message.content)
      ? message.content.filter(support.isObject)
      : [];
    const blockTypes = new Set(blocks.map((block) => support.textValue(block.type)));
    const role = claudeRole(
      row,
      message.role,
      blockTypes,
      blocks.some((block) => block.type === "hook_result"),
    );
    const normalizedText = structuredRole(role)
      ? support.jsonText(message.content)
      : support.contentText(message.content) ?? "";
    const text = role === 'user' ? support.displayUserText(normalizedText) : normalizedText;
    const turnId = support.textValue(row.uuid);
    const parentTurnId = support.textValue(row.parentUuid);
    const usage = support.numericUsage(message.usage);
    const providerOccurredAt = support.textValue(row.timestamp);
    return {
      role,
      text,
      audience: (role === 'user' || role === 'assistant') && text.trim() !== ''
        ? 'conversation'
        : 'internal',
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
