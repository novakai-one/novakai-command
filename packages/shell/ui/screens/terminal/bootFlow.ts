// The first window: restore what Chris had, or open one — in that order.
//
// A plain async function for the reason tabCloseFlow.ts is one: the dangerous
// thing here is the ORDER, not the React state around it. B1.5 found the order
// wrong against a real backed host — the mount effect opened a pty before the
// browser had laid the surface out, so a real process was started at the fit
// addon's floor of two columns and every prompt it drew afterwards was mangled
// in the session's permanent history.
//
// So the measurement is an INPUT here, and "not measured yet" is one of the
// answers. Nothing in this file reaches for an element.
import { chooseAdoptable, SHELL_INSTANCE_ID } from '../../../contract/terminalServices.js';
import type { TerminalOutcome, TerminalTabView } from '../../../contract/terminalServices.js';
import { listOpenTerminalTabs, type TerminalTabRecord } from '../../../contract/terminalTab.js';
import type { TerminalViewport } from '../../../contract/terminalViewport.js';
import type { ShellTerminalTabServices } from '../../../contract/services.js';

/** The two Runtime reads the boot needs, and nothing else. */
export interface BootTerminalServices {
  listTerminals(): Promise<TerminalOutcome<readonly TerminalTabView[]>>;
  openTerminal(workingDirectory: string, columns: number, rows: number):
    Promise<TerminalOutcome<TerminalTabView>>;
}

export interface TabBootWiring {
  readonly tabs: ShellTerminalTabServices;
  readonly services: BootTerminalServices;
  readonly workingDirectory: string;
  /**
   * What the surface measures, or `null` when it has not been measured yet.
   * Required — an optional viewport is an invitation to fall back to 80x24,
   * which is the defect wearing a different number.
   */
  readonly viewport: TerminalViewport | null;
  readonly newTabId: () => string;
  readonly opId: () => string;
}

export type TabBoot =
  /** The surface has no size yet. Nothing was opened; ask again after layout. */
  | { readonly kind: 'not-measured' }
  | {
    readonly kind: 'restored';
    readonly records: readonly TerminalTabRecord[];
    readonly views: readonly TerminalTabView[];
  }
  | {
    readonly kind: 'opened';
    readonly record: TerminalTabRecord;
    readonly views: readonly TerminalTabView[];
  }
  | { readonly kind: 'problem'; readonly message: string; readonly views: readonly TerminalTabView[] };

/**
 * Reuse the session this tab left running, or start one. Reuse is the normal
 * case — but only of a session this shell owns, in this directory. Anything else
 * on the machine belongs to someone else (see `chooseAdoptable`).
 *
 * Lives here rather than beside the xterm helpers because it is half of the boot
 * order and touches no terminal object.
 */
export async function adoptOrOpen(
  services: BootTerminalServices,
  workingDirectory: string,
  viewport: TerminalViewport,
  known?: readonly TerminalTabView[],
): Promise<TerminalOutcome<TerminalTabView>> {
  let existing: readonly TerminalTabView[] = known ?? [];
  if (known === undefined) {
    const listed = await services.listTerminals();
    existing = listed.succeeded ? listed.value : [];
  }
  const reuse = chooseAdoptable(existing, workingDirectory, SHELL_INSTANCE_ID);
  if (reuse) return { succeeded: true, value: reuse };
  return services.openTerminal(workingDirectory, viewport.columns, viewport.rows);
}

export async function bootTerminalTabs(wiring: TabBootWiring): Promise<TabBoot> {
  const { tabs, services, workingDirectory, viewport } = wiring;
  const restored = await listOpenTerminalTabs(tabs);
  const listed = await services.listTerminals();
  const views = listed.succeeded ? listed.value : [];

  // A restore starts no process, so it needs no measurement — and making it wait
  // for one would leave a reloaded page showing nothing on the one path that
  // must always come back to the windows Chris had.
  if (restored.length > 0) return { kind: 'restored', records: restored, views };

  if (viewport === null) return { kind: 'not-measured' };

  const session = await adoptOrOpen(services, workingDirectory, viewport, views);
  if (!session.succeeded) {
    return { kind: 'problem', message: `${session.code}: ${session.message}`, views };
  }
  // The record is written only once a session actually came up: a record written
  // first would leave a tab pointing at a session that never existed.
  const created = await tabs.save(
    wiring.newTabId(),
    { terminalSessionId: session.value.terminalSessionId },
    wiring.opId(),
  );
  if (!created.ok) {
    return { kind: 'problem', message: `${created.error.code}: ${created.error.message}`, views };
  }
  const seen = views.some(
    (item) => item.terminalSessionId === session.value.terminalSessionId,
  );
  return {
    kind: 'opened',
    record: created.value.record,
    views: seen ? views : [...views, session.value],
  };
}
