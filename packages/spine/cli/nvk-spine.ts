#!/usr/bin/env node
// Offline adapter over the same opaque Spine host used in-process. Messaging
// is composed only through its published public door; no app store/private
// implementation crosses this adapter.
import path from 'node:path';
import {
  authenticate,
  type ArtifactId,
  type ClientOpId,
  type ProjectId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  createEmbeddedMessaging,
  createSystemClock,
  DEFAULT_ROLE_GRANTS,
  openJsonlStore,
  type EmbeddedMessaging,
  type MessagingSession,
  type PersonId,
} from '@novakai/messaging/dist/public/index.js';
import { composeProjects } from '@novakai/projects';
import { composeArtifacts } from '@novakai/artifacts';
import {
  composeSpine,
  type SpineHost,
  type SpineWorkflow,
  type SpineWorkflowId,
} from '../contract/index.js';

interface ParsedArgs {
  verb: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [verb = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      flags[key] = value;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { verb, flags };
}

function required(
  value: string | boolean | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw {
      code: 'Usage',
      message: `--${name} is required`,
      details: { field: name },
      retryable: false,
    };
  }
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function outputError(error: unknown, exitCode = 1): void {
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exitCode = exitCode;
}

async function composeAuthenticatedSpine(
  root: string,
  bearer: string,
  lockTimeoutMs?: number,
): Promise<{
  host: SpineHost;
  messaging: EmbeddedMessaging;
}> {
  if (!bearer) {
    throw {
      code: 'AuthFailed',
      message: 'provide --token <bearer> or NOVAKAI_TOKEN',
      details: { cause: 'missing bearer' },
      retryable: false,
    };
  }
  const token = authenticate(root, bearer);
  if (!token) {
    throw {
      code: 'AuthFailed',
      message: 'bearer token not recognized',
      details: { cause: 'unknown bearer' },
      retryable: false,
    };
  }
  if (!token.grants.includes('spine')) {
    throw {
      code: 'AuthFailed',
      message: 'bearer token lacks the spine grant',
      details: { cause: 'spine grant missing' },
      retryable: false,
    };
  }

  const clock = createSystemClock();
  const store = await openJsonlStore(clock, {
    path: path.join(root, 'messaging.jsonl'),
  });
  const messaging = createEmbeddedMessaging({
    clock,
    store,
    authority: {
      principals: [{
        token: bearer,
        personId: token.principal as PersonId,
        roles: [],
      }],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  await messaging.start();
  const authenticated = await messaging.authenticate({ token: bearer });
  if (authenticated.kind !== 'authenticated') {
    await messaging.close();
    throw {
      code: 'AuthFailed',
      message: `Messaging rejected the Foundation principal (${authenticated.kind})`,
      details: { cause: authenticated.error.message },
      retryable: authenticated.kind === 'unavailable',
    };
  }
  const session: MessagingSession = authenticated.session;
  const projects = composeProjects({
    root,
    principal: 'sys_spine',
    lockTimeoutMs,
  });
  const artifacts = composeArtifacts({
    root,
    principal: 'sys_spine',
    lockTimeoutMs,
  });
  return {
    host: composeSpine({
      root,
      principal: 'sys_spine',
      lockTimeoutMs,
      messaging: session,
      projects: projects.spine,
      artifacts: artifacts.operations,
    }),
    messaging,
  };
}

function printResult<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): void {
  if (result.ok) output(result.value);
  else outputError(result.error);
}

async function main(): Promise<void> {
  const { verb, flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.root === 'string'
    ? flags.root
    : (process.env.NOVAKAI_ROOT ?? '.novakai');
  const bearer = typeof flags.token === 'string'
    ? flags.token
    : (process.env.NOVAKAI_TOKEN ?? '');
  const lockTimeoutMs = typeof flags['lock-timeout-ms'] === 'string'
    ? Number(flags['lock-timeout-ms'])
    : undefined;
  const composed = await composeAuthenticatedSpine(
    root,
    bearer,
    lockTimeoutMs,
  );
  try {
    const spine = composed.host.operations;
    if (verb === 'add-message') {
      return printResult(await spine.addMessageToProject({
        messageId: required(flags.message, 'message') as never,
        projectId: required(flags.project, 'project') as ProjectId,
        ...(typeof flags.note === 'string' ? { note: flags.note } : {}),
      }, required(flags['client-op-id'], 'client-op-id') as ClientOpId));
    }
    if (verb === 'attach-artifact') {
      return printResult(await spine.attachArtifactToProject({
        artifactId: required(flags.artifact, 'artifact') as ArtifactId,
        projectId: required(flags.project, 'project') as ProjectId,
        ...(typeof flags.note === 'string' ? { note: flags.note } : {}),
      }, required(flags['client-op-id'], 'client-op-id') as ClientOpId));
    }
    if (verb === 'workflows') {
      return printResult(await spine.getSpineWorkflows());
    }
    if (verb === 'status') {
      const workflowId = required(
        flags.workflow,
        'workflow',
      ) as SpineWorkflowId;
      const workflows = await spine.getSpineWorkflows();
      if (!workflows.ok) return outputError(workflows.error);
      const workflow: SpineWorkflow | undefined = workflows.value.items.find(
        (candidate) => candidate.workflowId === workflowId,
      );
      return workflow
        ? output(workflow)
        : outputError({
            code: 'SpineWorkflowNotFound',
            message: `Spine workflow "${workflowId}" does not exist`,
            details: { workflowId },
            retryable: false,
          });
    }
    if (verb === 'continue') {
      return printResult(await spine.continueWorkflow(
        required(flags.workflow, 'workflow') as SpineWorkflowId,
        required(flags['client-op-id'], 'client-op-id') as ClientOpId,
      ));
    }
    if (verb === 'abandon') {
      return printResult(await spine.abandonWorkflow(
        required(flags.workflow, 'workflow') as SpineWorkflowId,
        required(flags['client-op-id'], 'client-op-id') as ClientOpId,
      ));
    }
    outputError({
      code: 'Usage',
      message: 'verbs: add-message | attach-artifact | workflows | status | continue | abandon',
    }, 2);
  } finally {
    await composed.messaging.close();
  }
}

void main().catch((error: unknown) => {
  outputError(error, 1);
});
