import type {
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  Result,
} from '@novakai/foundation/dist/contract/types.js';
import type {
  Artifact,
  PutArtifactInput,
} from '../contract/schemas.js';
import type { ArtifactsError } from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';
import * as artifacts from './artifacts.js';

export interface ArtifactsContract {
  putArtifact(
    input: PutArtifactInput,
    clientOpId: ClientOpId,
  ): Promise<Result<Artifact, ArtifactsError>>;
}

export function createArtifactsContract(
  ctx: ArtifactsContext,
): ArtifactsContract {
  return {
    putArtifact: (input, clientOpId) =>
      artifacts.putArtifact(ctx, input, clientOpId),
  };
}
