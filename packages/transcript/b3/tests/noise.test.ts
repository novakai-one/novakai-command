/**
 * B3c — the signal/noise projection (§8.2, red gate 17, §24.6).
 *
 * "Terminal ANSI/tool/progress traffic becomes a Message" is red gate 17 — an
 * architecture failure regardless of score. The other half matters just as
 * much and is easier to get wrong quietly: "valid conversation turns are never
 * silently dropped." A filter that drops everything passes the first test and
 * fails the product.
 *
 * So every case here is paired: something that must be filtered, and something
 * adjacent that must survive.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyTurn, stripTerminalControl } from "../core/noise.js";

test("CSI colour and cursor sequences are stripped from Message text", () => {
  const painted = "[1;32mBuild passed[0m[2K[1A";
  assert.equal(stripTerminalControl(painted), "Build passed");
});

test("an OSC title sequence is stripped, terminator and all", () => {
  // Providers set the window title constantly. Left in, every turn would carry
  // the tab name of whatever the user last opened.
  const withTitle = "]0;kimi — ~/ProgrammingHello";
  assert.equal(stripTerminalControl(withTitle), "Hello");
  const stTerminated = "]2;title\\Hello";
  assert.equal(stripTerminalControl(stTerminated), "Hello");
});

test("a bare CR is a row end, not a character to keep", () => {
  // The kimi CLI repaints one row with a bare CR and no LF. Treating it as
  // ordinary text glues two repaints of the same row into one doubled line.
  assert.equal(stripTerminalControl("loading...\rdone"), "done");
  assert.equal(stripTerminalControl("first\r\nsecond"), "first\nsecond");
});

test("text that merely MENTIONS an escape is not mangled", () => {
  // The pairing that matters: an Agent discussing ANSI codes must keep its
  // words. Stripping on the literal characters, not on the word.
  const discussion = "Use \\u001b[31m for red, or chalk.red instead.";
  assert.equal(stripTerminalControl(discussion), discussion);
});

test("only human and assistant turns become Messages", () => {
  assert.equal(classifyTurn({ role: "user", text: "do the thing" }).kind, "message");
  assert.equal(classifyTurn({ role: "assistant", text: "done" }).kind, "message");
});

test("tool chatter, system frames and attachments stay transcript evidence", () => {
  for (const role of ["tool", "tool_call", "tool_result", "system", "attachment"] as const) {
    const outcome = classifyTurn({ role, text: "Read(file.ts)" });
    assert.equal(outcome.kind, "filtered", `${role} became a Message`);
    assert.equal(outcome.reason, "non-conversation-role");
  }
});

test("an assistant turn that is only control noise is filtered, not empty-committed", () => {
  // A repaint frame with no words is not a turn. Committing it would put an
  // empty Message in Chris's conversation for every screen redraw.
  const outcome = classifyTurn({ role: "assistant", text: "[2K[1A\r" });
  assert.equal(outcome.kind, "filtered");
  assert.equal(outcome.reason, "empty-after-control-strip");
});

test("an assistant turn with words AND control noise keeps the words", () => {
  const outcome = classifyTurn({
    role: "assistant", text: "[2K[32mI finished the task[0m",
  });
  assert.equal(outcome.kind, "message");
  if (outcome.kind !== "message") return;
  assert.equal(outcome.text, "I finished the task");
});

test("a progress spinner line is filtered but the sentence after it is not", () => {
  const spinner = classifyTurn({ role: "assistant", text: "⠋ Thinking…" });
  assert.equal(spinner.kind, "filtered");
  assert.equal(spinner.reason, "progress-frame");

  const real = classifyTurn({ role: "assistant", text: "Thinking about the cache design." });
  assert.equal(real.kind, "message");
});

test("a usage/cost line is filtered; a sentence containing a number is not", () => {
  const usage = classifyTurn({
    role: "assistant", text: "tokens: 12,345 in · 6,789 out · $0.42",
  });
  assert.equal(usage.kind, "filtered");
  assert.equal(usage.reason, "usage-line");

  const sentence = classifyTurn({
    role: "assistant", text: "The retry budget is 3 attempts and costs about $0.01.",
  });
  assert.equal(sentence.kind, "message", "a sentence with a price was dropped as usage");
});

test("a slash-command UI frame is filtered; a message about one is not", () => {
  const frame = classifyTurn({ role: "assistant", text: "/help  /model  /compact" });
  assert.equal(frame.kind, "filtered");

  const about = classifyTurn({
    role: "assistant", text: "Run /compact when the thread gets expensive.",
  });
  assert.equal(about.kind, "message");
});

test("a serialised content-part array is filtered; prose about JSON is not", () => {
  // kimi's `turn.prompt` row carries the input array it was handed, and the
  // same words arrive one position later as prose (`context.append_message`).
  // Committing both made one typed turn two Messages — exam row C1-kimi.
  const parts = classifyTurn({
    role: "user",
    text: JSON.stringify([{ type: "text", text: "add the retry budget" }]),
  });
  assert.equal(parts.kind, "filtered");
  assert.equal(parts.kind === "filtered" && parts.reason, "serialised-content-parts");

  // The eager-filter guard this file exists for. None of these is a payload.
  for (const text of [
    'The payload is [{"type":"text"}] — note the shape.',
    "[1, 2, 3]",
    '["just", "strings"]",',
    "[]",
    "[not json at all]",
  ]) {
    assert.equal(classifyTurn({ role: "user", text }).kind, "message",
      `a human turn was filtered as a serialised payload: ${text}`);
  }
});

test("whitespace-only and zero-length turns are filtered as empty", () => {
  assert.equal(classifyTurn({ role: "user", text: "   \n\t " }).kind, "filtered");
  assert.equal(classifyTurn({ role: "user", text: "" }).kind, "filtered");
});
