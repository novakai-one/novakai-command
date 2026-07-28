import type {
  ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  DeliveryListResult,
  Outcome,
} from '@novakai/messaging/dist/public/index.js';
import type { ArtifactsOperations } from '@novakai/artifacts';
import type { SpineProjectsContract } from '@novakai/projects';

/** Minimal Messaging query required to validate a message reference. */
export interface MessageExistenceQuery {
  getDelivery(input: unknown): Promise<Outcome<DeliveryListResult>>;
}

/** @internal private state shared by Spine's journal and executor. */
export interface SpineContext {
  readonly handle: ScopedStoreHandle;
  readonly messaging: MessageExistenceQuery;
  readonly projects: Pick<SpineProjectsContract, 'attach'>;
  readonly artifacts: Pick<ArtifactsOperations, 'getArtifactMeta'>;
  readonly configuredFailpoint?: string;
}
