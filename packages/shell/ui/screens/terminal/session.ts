// shell/ui/screens/terminal/session.ts — the terminal screen's pure helpers.
//
// Split out of TerminalScreen because none of them is React: they take a
// connection and give back a value, so they are readable and testable without
// mounting anything, and the controller is left with only the parts that
// genuinely need an effect. (It also keeps the screen under the 300-line
// ceiling the lint gate enforces, which is the same pressure pointing the same
// way.)
import { Terminal } from '@xterm/xterm';
import {
  chooseAdoptable, SHELL_INSTANCE_ID,
  type TerminalOutcome, type TerminalTabView,
} from '../../../contract/terminalServices.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';

/**
 * Reuse the session this tab left running, or start one. Reuse is the normal
 * case — but only of a session this shell owns, in this directory. Anything
 * else on the machine belongs to someone else (see `chooseAdoptable`).
 */
export async function adoptOrOpen(
  services: TerminalConnection, workingDirectory: string, columns: number, rows: number,
): Promise<TerminalOutcome<TerminalTabView>> {
  const existing = await services.listTerminals();
  const reuse = existing.succeeded
    ? chooseAdoptable(existing.value, workingDirectory, SHELL_INSTANCE_ID)
    : null;
  if (reuse) return { succeeded: true, value: reuse };
  return services.openTerminal(workingDirectory, columns, rows);
}

/**
 * xterm paints its own pixels, so it is handed the kit's tokens rather than a
 * second palette (§16: one token source). No gold: the composed viewport's one
 * attention signal belongs to the rail, and a cursor is not an exception.
 */
export function xtermTheme(): { background: string; foreground: string; cursor: string } {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string =>
    tokens.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--workspace', '#1b1b1e'),
    foreground: token('--ink', '#ececee'),
    cursor: token('--ink-2', '#b4b4bb'),
  };
}

export async function writeReplay(
  services: TerminalConnection, sessionId: string, screen: Terminal,
): Promise<void> {
  const replay = await services.readReplay(sessionId, 0);
  if (!replay.succeeded) return;
  for (const frame of replay.value) {
    // A gap is stated, never papered over with whatever bytes remain.
    screen.write(frame.kind === 'gap' ? '\r\n[earlier output is no longer buffered]\r\n' : frame.text);
  }
}
