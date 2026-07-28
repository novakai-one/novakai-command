import type {
  ArtifactId,
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  Absent,
  Page,
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
  getArtifactMeta(
    artifactId: ArtifactId,
  ): Promise<Result<Artifact | Absent, ArtifactsError>>;
  getArtifactBytes(
    artifactId: ArtifactId,
  ): Promise<Result<Uint8Array | Absent, ArtifactsError>>;
  listArtifacts(): Promise<Result<Page<Artifact>, ArtifactsError>>;
}

export function createArtifactsContract(
  ctx: ArtifactsContext,
): ArtifactsContract {
  return {
    putArtifact: (input, clientOpId) =>
      artifacts.putArtifact(ctx, input, clientOpId),
    getArtifactMeta: (artifactId) =>
      artifacts.getArtifactMeta(ctx, artifactId),
    getArtifactBytes: (artifactId) =>
      artifacts.getArtifactBytes(ctx, artifactId),
    listArtifacts: () => artifacts.listArtifacts(ctx),
  };
}
