import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { ArtifactsError } from '../contract/errors.js';

export type ArtifactFailpoint = (
  artifactId: ArtifactId,
  point: string,
) => ArtifactsError | null;

export function composeArtifactFailpoint(
  configuredPoint: string | undefined,
): ArtifactFailpoint {
  return (artifactId, point) => {
    if (configuredPoint !== point) return null;
    return err(
      'ArtifactFailpoint',
      `artifact failpoint injected at "${point}"`,
      { artifactId, point },
      true,
    );
  };
}
