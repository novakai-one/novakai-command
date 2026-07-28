import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { ArtifactsError } from '../contract/errors.js';

export function injectedFailpoint(
  artifactId: ArtifactId,
  point: string,
): ArtifactsError | null {
  if (process.env.NVK_FAILPOINT !== point) return null;
  return err(
    'ArtifactFailpoint',
    `artifact failpoint injected at "${point}"`,
    { artifactId, point },
    true,
  );
}
