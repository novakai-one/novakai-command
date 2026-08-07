import {
  composeArtifacts,
  type ArtifactsHost,
} from '../../../artifacts/contract/index.js';
import {
  composeProjects,
  type ProjectsHost,
} from '../../../projects/contract/index.js';
import {
  composeSpine,
  type MessageExistenceQuery,
  type SpineHost,
} from '../../../spine/contract/index.js';

export interface B2aServerCapabilities {
  readonly artifacts: ArtifactsHost;
  readonly projects: ProjectsHost;
  readonly spine: SpineHost;
}

export interface ComposeB2aServerCapabilitiesOptions {
  root: string;
  principal: string;
  messaging: MessageExistenceQuery;
  lockTimeoutMs?: number;
}

/** The Server composition root selects every B2a capability exactly once. */
export function composeB2aServerCapabilities(
  options: ComposeB2aServerCapabilitiesOptions,
): B2aServerCapabilities {
  const artifacts = composeArtifacts({
    root: options.root,
    principal: options.principal,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const projects = composeProjects({
    root: options.root,
    principal: options.principal,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const spine = composeSpine({
    root: options.root,
    principal: options.principal,
    messaging: options.messaging,
    projects: projects.spine,
    artifacts: artifacts.operations,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  return { artifacts, projects, spine };
}
