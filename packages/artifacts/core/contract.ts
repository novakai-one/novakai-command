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
  OrphanSweepResult,
  PutArtifactInput,
} from '../contract/schemas.js';
import type { ArtifactsError } from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';
import * as artifacts from './artifacts.js';
import * as orphanSweep from './orphan-sweep.js';

export interface ArtifactsOperations {
  putArtifact(
    input: PutArtifactInput,
    clientOpId: ClientOpId,
  ): Promise<Result<Artifact, ArtifactsError>>;
  getArtifactMeta(
    artifactId: ArtifactId,
  ): Promise<Result<Artifact | Absent, ArtifactsError>>;
  listArtifacts(): Promise<Result<Page<Artifact>, ArtifactsError>>;
}

export interface ArtifactHttpReader {
  getArtifactBytes(
    artifactId: ArtifactId,
  ): Promise<Result<Uint8Array | Absent, ArtifactsError>>;
}

export interface ArtifactBootMaintenance {
  sweepOrphans(): Promise<Result<OrphanSweepResult, ArtifactsError>>;
}

export interface ArtifactsHost {
  readonly operations: ArtifactsOperations;
  readonly http: ArtifactHttpReader;
  readonly boot: ArtifactBootMaintenance;
}

export function createArtifactsHost(
  ctx: ArtifactsContext,
): ArtifactsHost {
  return {
    operations: {
      putArtifact: (input, clientOpId) =>
        artifacts.putArtifact(ctx, input, clientOpId),
      getArtifactMeta: (artifactId) =>
        artifacts.getArtifactMeta(ctx, artifactId),
      listArtifacts: () => artifacts.listArtifacts(ctx),
    },
    http: {
      getArtifactBytes: (artifactId) =>
        artifacts.getArtifactBytes(ctx, artifactId),
    },
    boot: {
      sweepOrphans: () => orphanSweep.sweepOrphans(ctx),
    },
  };
}
