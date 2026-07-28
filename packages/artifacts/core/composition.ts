import path from 'node:path';
import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import {
  createArtifactsHost,
  type ArtifactsHost,
} from './contract.js';

export interface ArtifactsContext {
  readonly handle: ScopedStoreHandle;
  readonly root: string;
  readonly bytesRoot: string;
}

export interface ComposeArtifactsOptions {
  root: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
}

export function composeArtifacts(
  options: ComposeArtifactsOptions,
): ArtifactsHost {
  const root = path.resolve(options.root);
  const context: ArtifactsContext = {
    handle: composeHandle({
      root,
      legacyRoot: options.legacyRoot,
      capability: 'artifacts',
      allowedKinds: ['artifact'],
      principal: options.principal,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    root,
    bytesRoot: path.join(root, 'artifacts'),
  };
  return createArtifactsHost(context);
}
