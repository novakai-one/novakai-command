import type { Outcome } from '../../contract/outcome.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import { MessagingError } from '../../contract/types.js';
import { AddressedDeliveryReconciler } from '../delivery/addressed-delivery-reconciler.js';
import { routePendingDeliveries } from '../delivery/router.js';
import type { DurableTranscriptEventBus } from '../event-bus.js';

interface DeliveryRuntimeOptions {
  readonly store: TranscriptStore;
  readonly agents?: AgentDirectory;
  readonly conversations?: ConversationDirectory;
  readonly providerSend?: ProviderSend;
  readonly now: () => string;
}

const unavailable = (cause: unknown): Outcome<DeliveryRunResult> => ({
  kind: 'error',
  error: new MessagingError('DependencyUnavailable', {
    message: cause instanceof Error ? cause.message : 'Messaging delivery unavailable',
    retryable: true,
    fields: { dependency: 'provider-transcript' },
  }),
});

/**
 * Keeps delivery reconciliation, routing, and event pumping independent from
 * filesystem ingestion. Concurrent maintenance requests share one execution;
 * shutdown can wait until all active delivery work settles.
 */
export class DeliveryRuntime {
  private readonly addressed = new AddressedDeliveryReconciler();
  private deliveryInFlight: Promise<Outcome<DeliveryRunResult>> | undefined;
  private maintenanceInFlight: Promise<void> | undefined;
  private lastRun: string | undefined;

  constructor(private readonly options: DeliveryRuntimeOptions) {}

  get lastRunAt(): string | undefined {
    return this.lastRun;
  }

  maintain(eventBus: DurableTranscriptEventBus): Promise<void> {
    if (this.maintenanceInFlight !== undefined) return this.maintenanceInFlight;
    const run = this.performMaintenance(eventBus);
    this.maintenanceInFlight = run.finally(() => {
      this.maintenanceInFlight = undefined;
    });
    return this.maintenanceInFlight;
  }

  routePending(): Promise<Outcome<DeliveryRunResult>> {
    if (this.deliveryInFlight !== undefined) return this.deliveryInFlight;
    this.deliveryInFlight = this.runDelivery();
    return this.deliveryInFlight;
  }

  async waitForIdle(): Promise<void> {
    if (this.maintenanceInFlight !== undefined) await this.maintenanceInFlight;
    if (this.deliveryInFlight !== undefined) await this.deliveryInFlight;
  }

  private async performMaintenance(eventBus: DurableTranscriptEventBus): Promise<void> {
    await this.addressed.reconcile(this.options.store);
    if (this.composed()) {
      const routed = await this.routePending();
      if (routed.kind === 'error') throw routed.error;
    }
    await eventBus.pump();
  }

  private async runDelivery(): Promise<Outcome<DeliveryRunResult>> {
    try {
      if (!this.composed()) throw new Error('Messaging delivery dependencies are not composed');
      await this.addressed.reconcile(this.options.store);
      const value = await routePendingDeliveries({
        store: this.options.store,
        agents: this.options.agents!,
        conversations: this.options.conversations!,
        providerSend: this.options.providerSend!,
        now: this.options.now,
      });
      this.lastRun = this.options.now();
      return { kind: 'ok', value };
    } catch (cause) {
      return unavailable(cause);
    } finally {
      this.deliveryInFlight = undefined;
    }
  }

  private composed(): boolean {
    return this.options.agents !== undefined
      && this.options.providerSend !== undefined
      && this.options.conversations !== undefined;
  }
}
