/* eslint-disable id-length -- `ok` is the frozen result field every B3 caller
   reads (FZ-CLI-SCHEMA-001/011). */
// shell/app/mockAgentRuns.ts — FZ-VIEW-001, whole, for a host that has no
// Runtime behind it.
//
// It moved out of `mockServices.ts` when B3.2 built the three missing slices:
// the offline door went from three members to twenty-one, and a file that is
// mostly one door is a file where a missing slice is invisible again — which is
// exactly how finding L-20 survived seven seats.
//
// Every member answers the ONLY true thing this host can say: there is no
// Runtime here, so nothing was spawned, stopped, attached or asked. A refusal is
// a VALUE on the command half of the door as well as the read half, and that is
// what makes the interesting path — a stop that FAILS must leave the window
// exactly where it was — drivable offline in a browser instead of only in a unit
// test (contract/agentLifecycle.ts).
//
// Supervision is the exception and is answered for real, so the attention
// surface is drivable through the frozen door rather than around it (B2.5).
import type { NotificationView } from '../contract/index.js';
import type { ShellAgentServices } from '../contract/agentRuns.js';

/** Said once, as a value: this host has no Runtime, and that is not an empty list. */
const noRuntime = {
  ok: false as const,
  error: {
    code: 'RuntimeUnavailable',
    message: 'this host has no Novakai Runtime to read Agent Runs from',
  },
};

/**
 * The one piece of mock state this door needs. A port rather than the array
 * itself, so the inbox stays owned by `createMockServices` — which is also what
 * notifies its listeners.
 */
export interface OfflineNotificationInbox {
  list(): readonly NotificationView[];
  /** Replace one row and tell whoever is watching. */
  settle(notificationId: string, settled: NotificationView): void;
}

export function createOfflineAgentServices(
  inbox: OfflineNotificationInbox,
): ShellAgentServices {
  return {
    runtime: { async getRuntimeStatus() { return noRuntime; } },
    lifecycle: {
      async spawnAgent() { return noRuntime; },
      async interruptAgentTurn() { return noRuntime; },
      async stopAgent() { return noRuntime; },
      async prepareStopAgentTree() { return noRuntime; },
      async stopAgentTree() { return noRuntime; },
      async continueAgent() { return noRuntime; },
      async adoptAgent() { return noRuntime; },
    },
    terminal: {
      async attachController() { return noRuntime; },
      async detachController() { return noRuntime; },
      async acquireInputLease() { return noRuntime; },
      async releaseInputLease() { return noRuntime; },
      async writeInput() { return noRuntime; },
      async resizeTerminal() { return noRuntime; },
      async readTerminalStream() { return noRuntime; },
    },
    runs: {
      async getAgentRun() { return noRuntime; },
      async listAgentRuns() { return noRuntime; },
      async getAgentRunTree() { return noRuntime; },
    },
    communications: {
      async listAgentCommunications() {
        return {
          ok: false as const,
          error: {
            code: 'MessagingUnavailable',
            message: 'this host has no Novakai Runtime to read communications from',
          },
        };
      },
    },
    supervision: {
      async listNotifications(request) {
        return {
          ok: true as const,
          value: {
            items: inbox.list().slice(0, request.limit ?? 200).map((item) => ({ ...item })),
            omissions: [],
          },
        };
      },
      async acknowledgeNotification(notificationId: string) {
        // The mock enforces the same law the capability does: only a
        // Notification the provider was observed to receive can be settled.
        // A refusal is a typed value here too, so the screen's failure path
        // is reachable offline instead of only in a unit test.
        const target = inbox.list().find((item) => item.id === notificationId);
        if (target === undefined) {
          return {
            ok: false as const,
            error: { code: 'NotFound', message: `no notification ${notificationId}` },
          };
        }
        if (target.state !== 'transcript-observed') {
          return {
            ok: false as const,
            error: {
              code: 'InvalidStateTransition',
              message: `a notification in ${target.state} cannot be acknowledged`,
            },
          };
        }
        const settled: NotificationView = { ...target, state: 'acknowledged' };
        inbox.settle(notificationId, settled);
        return { ok: true as const, value: settled };
      },
    },
  };
}
