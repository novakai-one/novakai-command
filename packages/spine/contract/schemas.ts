import { z } from 'zod';
import { PermissionLevel } from '@novakai/foundation/dist/contract/schemas.js';
import type {
  ArtifactId,
  ClientOpId,
  ProjectId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { MessageId } from '@novakai/messaging/dist/public/index.js';

export type SpineWorkflowId = string & {
  readonly __brand: 'spineWorkflowId';
};

export const SpineWorkflowType = z.enum([
  'addMessageToProject',
  'attachArtifactToProject',
]);
export type SpineWorkflowType = z.infer<typeof SpineWorkflowType>;

export const SpineWorkflowState = z.enum([
  'accepted',
  'running',
  'done',
  'failed',
  'abandoned',
]);
export type SpineWorkflowState = z.infer<typeof SpineWorkflowState>;

export const SpineStepState = z.enum([
  'accepted',
  'running',
  'done',
  'failed',
  'abandoned',
]);
export type SpineStepState = z.infer<typeof SpineStepState>;

export const SpineSourceRef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string().regex(/^message_/),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    id: z.string().regex(/^artifact_/),
  }).strict(),
]);
export type SpineSourceRef = z.infer<typeof SpineSourceRef>;

export const SpineStep = z.object({
  kind: z.literal('spineStep'),
  id: z.string().regex(/^spineStep_/),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  workflowId: z.string().regex(/^spineWorkflow_/),
  workflowType: SpineWorkflowType,
  originalClientOpId: z.string().min(1),
  projectId: z.string().regex(/^proj_/),
  sourceRef: SpineSourceRef,
  note: z.string().min(1).optional(),
  state: SpineStepState,
  step: z.number().int().min(0).max(2),
  eventIndex: z.number().int().nonnegative(),
  effectOpId: z.string().min(1).optional(),
}).strict();
export type SpineStep = z.infer<typeof SpineStep>;

export const AddMessageToProjectInput = z.object({
  messageId: z.string().regex(/^message_/),
  projectId: z.string().regex(/^proj_/),
  note: z.string().min(1).optional(),
}).strict();
type ParsedAddMessage = z.infer<typeof AddMessageToProjectInput>;
export type AddMessageToProjectInput = Omit<
  ParsedAddMessage,
  'messageId' | 'projectId'
> & {
  messageId: MessageId;
  projectId: ProjectId;
};

export const AttachArtifactToProjectInput = z.object({
  artifactId: z.string().regex(/^artifact_/),
  projectId: z.string().regex(/^proj_/),
  note: z.string().min(1).optional(),
}).strict();
type ParsedAttachArtifact = z.infer<typeof AttachArtifactToProjectInput>;
export type AttachArtifactToProjectInput = Omit<
  ParsedAttachArtifact,
  'artifactId' | 'projectId'
> & {
  artifactId: ArtifactId;
  projectId: ProjectId;
};

export interface SpineWorkflowStep {
  number: 1 | 2;
  effectOpId: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

export interface SpineWorkflow {
  workflowId: SpineWorkflowId;
  workflowType: SpineWorkflowType;
  originalClientOpId: ClientOpId;
  projectId: ProjectId;
  sourceRef: SpineSourceRef;
  note?: string;
  state: SpineWorkflowState;
  acceptedAt: string;
  steps: [SpineWorkflowStep, SpineWorkflowStep];
  nextStep: 1 | 2 | null;
  resumable: boolean;
}
