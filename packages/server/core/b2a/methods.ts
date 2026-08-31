import { z } from 'zod';
import {
  isAbsent,
  type ArtifactId,
  type ClientOpId,
  type ProjectId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  Artifact,
  type Artifact as ArtifactRecord,
} from '../../../artifacts/contract/index.js';
import {
  CreateProjectInput,
  ListProjectsFilter,
  Project,
} from '../../../projects/contract/index.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { B2aServerCapabilities } from './composition.js';

const ClientOpIdInput = z.string().min(1);
const EmptyInput = z.object({}).strict();

const CreateProjectMethodInput = CreateProjectInput.extend({
  clientOpId: ClientOpIdInput,
}).strict();
const ArchiveProjectMethodInput = z.object({
  projectId: Project.shape.id,
  clientOpId: ClientOpIdInput,
}).strict();
const ProjectItemsMethodInput = z.object({
  projectId: Project.shape.id,
}).strict();
const ArtifactMetaMethodInput = z.object({
  artifactId: Artifact.shape.id,
}).strict();

interface InvalidMethodInput {
  ok: false;
  error: {
    code: 'InvalidEnvelope';
    message: string;
    details: {
      missingFields: string[];
      invalidFields: Array<{ field: string; reason: string }>;
    };
    retryable: false;
  };
}

interface WsArtifactMetadata {
  id: ArtifactRecord['id'];
  kind: ArtifactRecord['kind'];
  mimeType: string;
  byteSize: number;
  createdAt: string;
  status?: string;
}

function projectArtifactMetadata(
  artifact: ArtifactRecord,
): WsArtifactMetadata {
  const status = (
    artifact as ArtifactRecord & { status?: string }
  ).status;
  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt,
    ...(status === undefined ? {} : { status }),
  };
}

function parseInput<T>(
  method: string,
  schema: z.ZodType<T>,
  params: unknown,
): { ok: true; value: T } | InvalidMethodInput {
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const missingFields = parsed.error.issues
    .filter((issue) => issue.code === 'invalid_type' && issue.received === 'undefined')
    .map((issue) => issue.path.join('.') || '(root)');
  return {
    ok: false,
    error: {
      code: 'InvalidEnvelope',
      message: `${method} input is invalid`,
      details: {
        missingFields,
        invalidFields: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          reason: issue.message,
        })),
      },
      retryable: false,
    },
  };
}

/**
 * Translate untrusted WS params into the two approved public contracts.
 * Artifact byte operations and Projects' internal attachment door are
 * intentionally impossible to reach from this table.
 */
export function buildB2aMethods(
  capabilities: B2aServerCapabilities,
): MethodTable {
  const projects = capabilities.projects.operations;
  const artifacts = capabilities.artifacts.operations;
  return {
    async createProject(params: never) {
      const parsed = parseInput('createProject', CreateProjectMethodInput, params);
      if (!parsed.ok) return parsed;
      const { clientOpId, ...input } = parsed.value;
      return projects.createProject(input, clientOpId as ClientOpId);
    },
    async archiveProject(params: never) {
      const parsed = parseInput('archiveProject', ArchiveProjectMethodInput, params);
      if (!parsed.ok) return parsed;
      return projects.archiveProject(
        parsed.value.projectId as ProjectId,
        parsed.value.clientOpId as ClientOpId,
      );
    },
    async listProjects(params: never) {
      const parsed = parseInput('listProjects', ListProjectsFilter, params);
      if (!parsed.ok) return parsed;
      return projects.listProjects(parsed.value);
    },
    async getProjectItems(params: never) {
      const parsed = parseInput('getProjectItems', ProjectItemsMethodInput, params);
      if (!parsed.ok) return parsed;
      return projects.getProjectItems(parsed.value.projectId as ProjectId);
    },
    async getArtifactMeta(params: never) {
      const parsed = parseInput('getArtifactMeta', ArtifactMetaMethodInput, params);
      if (!parsed.ok) return parsed;
      const result = await artifacts.getArtifactMeta(
        parsed.value.artifactId as ArtifactId,
      );
      if (!result.ok || isAbsent(result.value)) return result;
      return {
        ok: true,
        value: projectArtifactMetadata(result.value),
      };
    },
    async listArtifacts(params: never) {
      const parsed = parseInput('listArtifacts', EmptyInput, params);
      if (!parsed.ok) return parsed;
      const result = await artifacts.listArtifacts();
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ...result.value,
          items: result.value.items.map(projectArtifactMetadata),
        },
      };
    },
  };
}
