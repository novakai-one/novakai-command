import type {
  NormalizedProviderLine,
  ProviderLineExtent,
} from "../../../contract/ports/provider-transcript-source.js";
import type { TranscriptRole } from "../../../contract/types.js";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const displayUserText = (value: string): string => {
  if (!value.startsWith('[novakai context] ')) return value;
  const newline = value.indexOf('\n');
  return newline < 0 ? value : value.slice(newline + 1);
};

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isObject(part)) return [];
    return typeof part.text === "string" ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function numericUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && Number(entry[1]) >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseExtent(extent: ProviderLineExtent): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(extent.raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const noise = (resumeId?: string): NormalizedProviderLine => ({
  role: "system",
  text: "",
  ...(resumeId === undefined ? {} : { resumeId }),
});

function declaredRole(value: unknown): TranscriptRole | undefined {
  return value === "user"
    || value === "assistant"
    || value === "system"
    || value === "tool"
    ? value
    : undefined;
}

/** Shared, pure parsing vocabulary for provider-specific normalizers. */
export const normalizerSupport = {
  contentText,
  declaredRole,
  displayUserText,
  isObject,
  jsonText,
  noise,
  numericUsage,
  parseExtent,
  textValue,
};
