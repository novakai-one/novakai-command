#!/usr/bin/env node
// Offline adapter over the same Projects contract used in-process.
// Deliberately composes only the ordinary contract: attach belongs to Spine.
import {
  authenticate,
  type ClientOpId,
  type ProjectId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeProjects,
  createProjectsContract,
  type ProjectStatus,
  type ProjectsContract,
} from '../contract/index.js';

interface CliArgs {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { verb: string; args: CliArgs } {
  const [verb = 'help', ...rest] = argv;
  const args: CliArgs = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return { verb, args };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error: unknown, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exit(exitCode);
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail({ code: 'Usage', message: `--${name} is required` });
  }
  return value;
}

function authenticateProjects(
  root: string,
  bearer: string,
  lockTimeoutMs?: number,
): ProjectsContract {
  if (!bearer) {
    process.stderr.write('auth: provide --token <bearer> or NOVAKAI_TOKEN\n');
    process.exit(2);
  }
  const token = authenticate(root, bearer);
  if (!token) {
    fail({
      code: 'AuthFailed',
      message: 'bearer token not recognized',
      details: { cause: 'unknown bearer' },
      retryable: false,
    });
  }
  return createProjectsContract(composeProjects({
    root,
    principal: token.principal,
    lockTimeoutMs,
  }));
}

async function main(): Promise<void> {
  const { verb, args } = parseArgs(process.argv.slice(2));
  const root = typeof args.root === 'string'
    ? args.root
    : (process.env.NOVAKAI_ROOT ?? '.novakai');
  const bearer = typeof args.token === 'string'
    ? args.token
    : (process.env.NOVAKAI_TOKEN ?? '');
  const lockTimeoutMs = typeof args['lock-timeout-ms'] === 'string'
    ? Number(args['lock-timeout-ms'])
    : undefined;
  const projects = authenticateProjects(root, bearer, lockTimeoutMs);
  if (verb === 'create') {
    const result = await projects.createProject(
      {
        title: required(args.title, 'title'),
        ...(typeof args['permission-level'] === 'string'
          ? {
              permissionLevel: args['permission-level'] as
                | 'private'
                | 'team'
                | 'external',
            }
          : {}),
      },
      required(args['client-op-id'], 'client-op-id') as ClientOpId,
    );
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'list') {
    const result = await projects.listProjects(
      typeof args.status === 'string'
        ? { status: args.status as ProjectStatus }
        : undefined,
    );
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'items') {
    const result = await projects.getProjectItems(
      required(args.project, 'project') as ProjectId,
    );
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'archive') {
    const result = await projects.archiveProject(
      required(args.project, 'project') as ProjectId,
      required(args['client-op-id'], 'client-op-id') as ClientOpId,
    );
    return result.ok ? output(result.value) : fail(result.error);
  }
  output({ authenticated: true, verb });
}

void main();
