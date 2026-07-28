import { z } from 'zod';
import {
  PermissionLevel,
  SourceAttribution,
} from '@novakai/foundation/dist/contract/schemas.js';
import type {
  ArtifactId,
} from '@novakai/foundation/dist/contract/brands.js';

export const Artifact = z.object({
  kind: z.literal('artifact'),
  id: z.string().regex(/^artifact_/),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  sourceAttribution: SourceAttribution.optional(),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  originPath: z.string().min(1).optional(),
});
type ParsedArtifact = z.infer<typeof Artifact>;
export type Artifact = Omit<ParsedArtifact, 'id'> & { id: ArtifactId };

export const PutArtifactInput = z.object({
  bytes: z.instanceof(Uint8Array),
  mimeType: z.string().min(1),
  originPath: z.string().min(1).optional(),
  permissionLevel: PermissionLevel.optional(),
  sourceAttribution: SourceAttribution.optional(),
}).strict();
export type PutArtifactInput = z.infer<typeof PutArtifactInput>;

export type OrphanEntryType = 'final' | 'temp';

export interface SweptOrphan {
  artifactId: ArtifactId;
  entryType: OrphanEntryType;
}

export interface OrphanSweepResult {
  swept: SweptOrphan[];
}

export type {
  ArtifactId,
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
export type { Result } from '@novakai/foundation/dist/contract/types.js';
