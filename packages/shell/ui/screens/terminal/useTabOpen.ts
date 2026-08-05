// Opening another window — the sibling of useTabClose.ts.
//
// Small, and separate for the same reason closing is: the two together are what
// "which windows Chris has" MEANS, and having one inline and one in a module is
// how the pair drifts. The screen composes them and renders; it does not carry
// the steps of either.
//
// Note the order: the SESSION is opened first, and only a session that actually
// came up gets a durable tab. A record written first would leave a tab pointing
// at a session that never existed — a window Chris cannot use and cannot explain.
import { useCallback } from 'react';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { TerminalTabRecord, TerminalTabView } from './openTypes.js';

export interface TabOpenWiring {
  readonly tabs: ShellTerminalTabServices;
  readonly openTerminal: (workingDirectory: string, columns: number, rows: number) => Promise<
    { readonly succeeded: true; readonly value: TerminalTabView }
    | { readonly succeeded: false; readonly code: string; readonly message: string }
  >;
  readonly workingDirectory: string;
  /** The viewport the new session should start at, asked for at press time. */
  readonly viewport: () => { readonly columns: number; readonly rows: number };
  readonly onOpened: (record: TerminalTabRecord) => void;
  readonly onProblem: (message: string) => void;
}

export function useTabOpen(wiring: TabOpenWiring): () => Promise<void> {
  const { tabs, openTerminal, workingDirectory, viewport, onOpened, onProblem } = wiring;
  return useCallback(async () => {
    const size = viewport();
    const session = await openTerminal(workingDirectory, size.columns, size.rows);
    if (!session.succeeded) {
      onProblem(`${session.code}: ${session.message}`);
      return;
    }
    const created = await tabs.save(
      `terminalTab_${globalThis.crypto.randomUUID()}`,
      { terminalSessionId: session.value.terminalSessionId },
      mintShellOpId(),
    );
    if (!created.ok) {
      onProblem(`${created.error.code}: ${created.error.message}`);
      return;
    }
    onOpened(created.value.record);
  }, [tabs, openTerminal, workingDirectory, viewport, onOpened, onProblem]);
}
