/**
 * Signal and noise — §8.2, red gate 17, §24.6.
 *
 * "Only human and assistant conversation turns become Messages. ANSI output,
 * tool chatter, progress lines, usage lines, slash-command UI and provider
 * control frames remain activity/transcript evidence."
 *
 * The dangerous half of that sentence is the second one, because a filter that
 * is too eager fails silently: nobody notices the turn that never arrived.
 * Every rule here is therefore written to key on SHAPE rather than on a word —
 * a line that *is* a usage readout is filtered; a sentence that mentions a
 * price is not. The paired tests exist to keep that distinction honest.
 *
 * Nothing here deletes anything. A filtered turn is still a transcript line
 * with a recorded outcome; filtering decides only what becomes a Message.
 */

/** The provider-neutral roles the existing normalisers already produce. */
export type TurnRole =
  | "user" | "assistant" | "system" | "tool" | "tool_call" | "tool_result" | "attachment";

export interface RawTurn {
  readonly role: TurnRole;
  readonly text: string;
}

export type FilterReason =
  | "non-conversation-role"
  | "empty"
  | "empty-after-control-strip"
  | "progress-frame"
  | "usage-line"
  | "slash-command-frame"
  | "serialised-content-parts";

export type TurnClassification =
  | { readonly kind: "message"; readonly role: "human" | "assistant"; readonly text: string }
  | { readonly kind: "filtered"; readonly reason: FilterReason };

// CSI: ESC [ ... final byte. Covers colour, cursor moves, erase-line, the lot.
const CSI_SEQUENCE = /\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... terminated by BEL or ST (ESC \). Window titles, hyperlinks.
const OSC_SEQUENCE = /\][^]*(?:|\\)/g;
// Two-character escapes that are not CSI or OSC (charset selects, RI, etc).
const SHORT_ESCAPE = /[()#][0-9A-Za-z]|[=>NOM78]/g;
// Remaining lone escapes, once the structured forms above are gone.
const LONE_ESCAPE = //g;

/**
 * Strip terminal control so what remains is what a person would have read.
 *
 * The bare-CR rule is provider-specific and hard-won: the kimi CLI repaints a
 * row with a carriage return and no line feed, so `loading...\rdone` is ONE
 * row that ended up saying "done". Keeping the CR would splice two repaints of
 * the same row into one doubled line. A CRLF is an ordinary line break and
 * survives as one.
 */
export function stripTerminalControl(text: string): string {
  const withoutControl = text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SHORT_ESCAPE, "")
    .replace(LONE_ESCAPE, "");
  return withoutControl
    .split("\n")
    .map((line) => {
      // A trailing CR is half of a CRLF — the line ended, nothing repainted.
      const ended = line.endsWith("\r") ? line.slice(0, -1) : line;
      // Everything before the last remaining bare CR was overwritten on screen.
      const lastRepaint = ended.lastIndexOf("\r");
      return lastRepaint === -1 ? ended : ended.slice(lastRepaint + 1);
    })
    .join("\n");
}

/** A spinner/progress frame: a braille or block spinner leading a short label. */
const PROGRESS = /^[⠀-⣿▀-▟■-◿|/\\-]+\s*\S[^\n]{0,60}$/u;

// A usage readout is three things at once: it names a usage field, it carries
// a number, and it is not a sentence. All three are needed. "cost" alone
// filters an Agent explaining a design; a number alone filters half of
// engineering; and "no sentence" is what separates `tokens: 12,345 · $0.42`
// from `The retry budget is 3 attempts and costs about $0.01.`
//
// Sentence-ending punctuation only counts when a space or the end follows it,
// so the `.` inside `$0.42` does not make a readout look like prose.
const SENTENCE_END = /[.!?](\s|$)/;
const USAGE_FIELD = /\b(tokens?|input|output|cost|cached|context)\b/i;
const CARRIES_NUMBER = /\d/;

const isUsageLine = (text: string): boolean =>
  !SENTENCE_END.test(text) && USAGE_FIELD.test(text) && CARRIES_NUMBER.test(text);

/** A slash-command menu frame: two or more bare commands and nothing else. */
const SLASH_FRAME = /^\s*(\/[a-z][\w-]*)(\s+\/[a-z][\w-]*)+\s*$/i;

/**
 * A provider's own content-part array, serialised — `[{"type":"text",…}]`.
 *
 * kimi writes a typed turn TWICE: `turn.prompt`, holding the input array it was
 * handed, and `context.append_message`, holding the message it appended. Both
 * normalise to `user`, so one thing a person typed reached the mirror as two
 * conversation turns at two source positions — exam row C1-kimi's "exactly one
 * committed Novakai Message", missed by one — and the first of the pair
 * committed a data structure where the words should be.
 *
 * Shape, not provider: a turn whose entire text is a JSON array of `{type: …}`
 * parts is a serialisation of a payload, never something a person typed. The
 * words are not lost — they arrive at the next position, as prose. Filtering is
 * not deleting: the position keeps a durable outcome naming this reason.
 */
function isSerialisedContentParts(text: string): boolean {
  if (!text.startsWith("[") || !text.endsWith("]")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return Array.isArray(parsed)
    && parsed.length > 0
    && parsed.every((part) => typeof part === "object" && part !== null
      && typeof (part as { type?: unknown }).type === "string");
}

/**
 * Decide what one normalised turn becomes.
 *
 * Order matters: the role gate runs first because a tool result that happens to
 * look like a sentence is still not a conversation turn, and running the shape
 * rules first would let it through.
 */
export function classifyTurn(turn: RawTurn): TurnClassification {
  if (turn.role !== "user" && turn.role !== "assistant") {
    return { kind: "filtered", reason: "non-conversation-role" };
  }
  if (turn.text.trim() === "") return { kind: "filtered", reason: "empty" };

  const text = stripTerminalControl(turn.text).trim();
  if (text === "") return { kind: "filtered", reason: "empty-after-control-strip" };
  if (isSerialisedContentParts(text)) {
    return { kind: "filtered", reason: "serialised-content-parts" };
  }
  if (SLASH_FRAME.test(text)) return { kind: "filtered", reason: "slash-command-frame" };
  if (PROGRESS.test(text)) return { kind: "filtered", reason: "progress-frame" };
  if (isUsageLine(text)) return { kind: "filtered", reason: "usage-line" };

  return {
    kind: "message",
    role: turn.role === "user" ? "human" : "assistant",
    text,
  };
}
