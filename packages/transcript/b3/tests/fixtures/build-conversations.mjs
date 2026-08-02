// Writes the three provider CONVERSATION fixtures used by the §25-B3c
// three-provider round-trip proof.
//
// Generated rather than checked in as literals for one reason: the fixtures
// contain real ANSI escapes, and an escape pasted into a source file is
// invisible — a reviewer cannot tell a correct fixture from a broken one, and
// an editor that strips control characters silently guts the test. Generating
// them makes the escape explicit (String.fromCharCode(27)) and reproducible.
//
// The SHAPES are the providers' own, taken from the real-shape corpus already
// in packages/transcript/tests/fixtures/real-shapes/. Each conversation is the
// same exchange in three dialects, so a difference in the round-trip is a
// difference in Novakai rather than in the fixture:
//
//   1  human    asks for something                → one Message
//   2  tool call                                  → filtered (tool chatter)
//   3  tool result                                → filtered (tool chatter)
//   4  assistant answers, wrapped in ANSI colour  → one Message, colour stripped
//   5  assistant prints a usage readout           → filtered (usage line)
//
// Two Messages per provider. Six in total, each exactly once.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ESC, by code point rather than as a literal.
 *
 * A pasted escape character is invisible in a source file: a reviewer cannot
 * tell a correct fixture from a broken one, and several tools strip control
 * characters silently — which would gut this proof while leaving it green.
 * `String.fromCharCode(27)` is the same byte and can be read.
 */
const ESC = String.fromCharCode(27);
const ANSWER = `${ESC}[32mDone${ESC}[0m — the retry budget is 3 attempts.`;
const USAGE = 'tokens: 12,345 input · 6,789 output';
const ASK = 'add the retry budget to the spawn path';
const CODE = 'export function spawn() {}';

export const EXPECTED_MESSAGES = [ASK, 'Done — the retry budget is 3 attempts.'];

const claude = [
  { type: 'user', uuid: 'b3c_claude_u1', parentUuid: null, sessionId: 'b3c_claude_session',
    message: { role: 'user', content: [{ type: 'text', text: ASK }] } },
  { type: 'assistant', uuid: 'b3c_claude_a1', parentUuid: 'b3c_claude_u1', sessionId: 'b3c_claude_session',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b3c', name: 'Read', input: { file_path: 'spawn.ts' } }] } },
  { type: 'user', uuid: 'b3c_claude_tr1', parentUuid: 'b3c_claude_a1', sessionId: 'b3c_claude_session',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b3c', content: CODE }] } },
  { type: 'assistant', uuid: 'b3c_claude_a2', parentUuid: 'b3c_claude_tr1', sessionId: 'b3c_claude_session',
    message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
  { type: 'assistant', uuid: 'b3c_claude_a3', parentUuid: 'b3c_claude_a2', sessionId: 'b3c_claude_session',
    message: { role: 'assistant', content: [{ type: 'text', text: USAGE }] } },
];

const codex = [
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ASK }], id: 'b3c_codex_u1', turn_id: 'b3c_codex_turn' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'cat spawn.ts' }), call_id: 'b3c_codex_call', turn_id: 'b3c_codex_turn' } },
  { type: 'response_item', payload: { type: 'function_call_output', output: CODE, call_id: 'b3c_codex_call', turn_id: 'b3c_codex_turn' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }], id: 'b3c_codex_a1', turn_id: 'b3c_codex_turn' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: USAGE }], id: 'b3c_codex_a2', turn_id: 'b3c_codex_turn' } },
];

const kimiEvent = (seq, type, payload) => ({
  kind: 'event',
  envelope: { seq, type, payload: { ...payload, sessionId: 'b3c_kimi_session', type } },
});

// kimi does NOT carry conversation turns as a `message` object with a content
// array the way claude and codex do — a human turn is `payload.prompt` and an
// assistant turn is `payload.output` on an `assistant_output` event. Writing
// the claude shape here and calling it a kimi fixture is exactly the mistake
// that makes a three-provider proof prove one provider three times.
const kimi = [
  kimiEvent(0, 'assistant_output', { agentId: 'b3c_kimi_agent', turnId: 7, prompt: ASK }),
  kimiEvent(1, 'tool.call.started', { agentId: 'b3c_kimi_agent', turnId: 7, name: 'Bash', toolCallId: 'b3c_kimi_tool', args: { command: 'cat spawn.ts' } }),
  kimiEvent(2, 'tool.result', { agentId: 'b3c_kimi_agent', turnId: 7, toolCallId: 'b3c_kimi_tool', output: CODE }),
  kimiEvent(3, 'assistant_output', { agentId: 'b3c_kimi_agent', turnId: 7, output: ANSWER }),
  kimiEvent(4, 'assistant_output', { agentId: 'b3c_kimi_agent', turnId: 7, output: USAGE }),
];

const here = path.dirname(fileURLToPath(import.meta.url));

export function writeConversationFixtures(directory = here) {
  const written = {};
  for (const [provider, rows] of [['claude', claude], ['codex', codex], ['kimi', kimi]]) {
    const file = path.join(directory, `${provider}-conversation.jsonl`);
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    written[provider] = file;
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = writeConversationFixtures();
  process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
}
