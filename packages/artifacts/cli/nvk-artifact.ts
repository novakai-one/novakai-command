#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  authenticate,
  type ClientOpId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
  createArtifactsContract,
  type ArtifactsContract,
} from '../contract/index.js';

interface ParsedArgs {
  verb: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [verb = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      flags[key] = value;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { verb, positional, flags };
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
    fail({ code: 'Usage', message: `${name} is required` }, 2);
  }
  return value;
}

function authenticatedContract(
  root: string,
  bearer: string,
): ArtifactsContract {
  if (!bearer) {
    fail({
      code: 'AuthFailed',
      message: 'provide --token <bearer> or NOVAKAI_TOKEN',
      details: { cause: 'missing bearer' },
      retryable: false,
    }, 2);
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
  if (!token.grants.includes('artifact')) {
    fail({
      code: 'AuthFailed',
      message: 'bearer token lacks the artifact grant',
      details: { cause: 'artifact grant missing' },
      retryable: false,
    });
  }
  return createArtifactsContract(composeArtifacts({
    root,
    principal: token.principal,
  }));
}

async function main(): Promise<void> {
  const { verb, positional, flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.root === 'string'
    ? flags.root
    : (process.env.NOVAKAI_ROOT ?? '.novakai');
  const bearer = typeof flags.token === 'string'
    ? flags.token
    : (process.env.NOVAKAI_TOKEN ?? '');
  const artifacts = authenticatedContract(root, bearer);

  if (verb === 'put') {
    const sourcePath = required(positional[0], 'put <path>');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const source = await readFile(sourcePath);
      bytes = new Uint8Array(source.byteLength);
      bytes.set(source);
    } catch (cause) {
      fail({
        code: 'ArtifactSourceReadFailed',
        message: `artifact source could not be read: ${String(cause)}`,
        details: { cause: String(cause) },
        retryable: false,
      });
    }
    const result = await artifacts.putArtifact({
      bytes,
      mimeType: typeof flags['mime-type'] === 'string'
        ? flags['mime-type']
        : 'application/octet-stream',
      originPath: sourcePath,
    }, required(flags['client-op-id'], '--client-op-id') as ClientOpId);
    return result.ok ? output(result.value) : fail(result.error);
  }

  fail({
    code: 'Usage',
    message: 'verbs: put',
  }, 2);
}

void main();
