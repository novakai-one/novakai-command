/** Existing Shell layout, terminal-tab and settings methods. */

import { getLayoutVersioned, setLayout } from '../../../shell/contract/layout.js';
import {
  closeTerminalTab,
  setTerminalTab,
  type TerminalTabPatch,
} from '../../../shell/contract/terminalTab.js';
import * as settingsContract from '../../../shell/contract/settings.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { ServerRuntime } from './runtime.js';

export function buildShellStateMethods(runtime: ServerRuntime): MethodTable {
  return {
    async getLayout() {
      return getLayoutVersioned(runtime.persistence.layoutDriver);
    },
    async setLayout(params: never) {
      const input = params as { patch: Record<string, unknown>; clientOpId: string };
      return setLayout(runtime.persistence.layoutDriver, input.patch, input.clientOpId);
    },
    async listTerminalTabs() {
      return runtime.persistence.terminalTabDriver.list();
    },
    async setTerminalTab(params: never) {
      const input = params as { id: string; patch: TerminalTabPatch; clientOpId: string };
      return setTerminalTab(
        runtime.persistence.terminalTabDriver,
        input.id,
        input.patch,
        input.clientOpId,
      );
    },
    async closeTerminalTab(params: never) {
      const input = params as { id: string; clientOpId: string };
      return closeTerminalTab(
        runtime.persistence.terminalTabDriver,
        input.id,
        input.clientOpId,
      );
    },
    async getSettings() {
      return settingsContract.getSettings(runtime.persistence.settingsDriver);
    },
    async setSetting(params: never) {
      const input = params as {
        key: string;
        value: unknown;
        opts: Parameters<typeof settingsContract.setSetting>[3];
      };
      return settingsContract.setSetting(
        runtime.persistence.settingsDriver,
        input.key,
        input.value,
        input.opts,
      );
    },
  };
}
