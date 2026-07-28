import type {
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  Page,
  Result,
} from '@novakai/foundation/dist/contract/types.js';
import type {
  DeliveryListResult,
  Outcome,
} from '@novakai/messaging/dist/public/index.js';
import type {
  AddMessageToProjectInput,
  AttachArtifactToProjectInput,
  SpineWorkflow,
} from '../contract/schemas.js';
import type { SpineError } from '../contract/errors.js';
import type { SpineContext } from './composition.js';
import * as workflows from './workflows.js';

export interface MessageExistenceQuery {
  getDelivery(input: unknown): Promise<Outcome<DeliveryListResult>>;
}

export interface SpineOperations {
  addMessageToProject(
    input: AddMessageToProjectInput,
    clientOpId: ClientOpId,
  ): Promise<Result<SpineWorkflow, SpineError>>;
  attachArtifactToProject(
    input: AttachArtifactToProjectInput,
    clientOpId: ClientOpId,
  ): Promise<Result<SpineWorkflow, SpineError>>;
  getSpineWorkflows(): Promise<Result<Page<SpineWorkflow>, SpineError>>;
}

export interface SpineBoot {
  scanWorkflows(): Promise<Result<Page<SpineWorkflow>, SpineError>>;
}

export interface SpineHost {
  readonly operations: SpineOperations;
  readonly boot: SpineBoot;
}

export function createSpineHost(ctx: SpineContext): SpineHost {
  const getSpineWorkflows = () => workflows.getSpineWorkflows(ctx);
  return {
    operations: {
      addMessageToProject: (input, clientOpId) =>
        workflows.addMessageToProject(ctx, input, clientOpId),
      attachArtifactToProject: (input, clientOpId) =>
        workflows.attachArtifactToProject(ctx, input, clientOpId),
      getSpineWorkflows,
    },
    boot: {
      scanWorkflows: getSpineWorkflows,
    },
  };
}
