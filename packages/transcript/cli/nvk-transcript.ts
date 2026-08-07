#!/usr/bin/env node
import {
  authenticate,
} from '@novakai/foundation/dist/contract/index.js';
import {
  ProviderName,
  SessionRef,
  composeTranscript,
  createProviderIdentityResolvers,
  createRawTranscriptSource,
  loadProviderIdentityRecords,
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

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error: unknown, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exit(exitCode);
}

function required(
  value: string | boolean | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail({
      code: 'Usage',
      message: `--${name} is required`,
    }, 2);
  }
  return value;
}

async function main(): Promise<void> {
  const { verb, flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.root === 'string'
    ? flags.root
    : (process.env.NOVAKAI_ROOT ?? '.novakai');
  const bearer = typeof flags.token === 'string'
    ? flags.token
    : (process.env.NOVAKAI_TOKEN ?? '');
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
  if (!token.grants.includes('transcriptLine')) {
    fail({
      code: 'AuthFailed',
      message: 'bearer token lacks the transcriptLine grant',
      details: { cause: 'transcriptLine grant missing' },
      retryable: false,
    });
  }
  const identities = createProviderIdentityResolvers(
    await loadProviderIdentityRecords(root),
  );
  const transcript = composeTranscript({
    root,
    source: createRawTranscriptSource({
      root,
      resolveSessionRef: identities.resolveSessionRef,
      resolveAgentId: identities.resolveAgentId,
    }),
  });

  if (verb === 'ingest') {
    const result = await transcript.ingest();
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'status') {
    const result = await transcript.status();
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'lines-by-session') {
    const parsed = SessionRef.safeParse(required(flags.session, 'session'));
    if (!parsed.success) {
      fail({
        code: 'Usage',
        message: '--session must be a non-empty providerSession handle',
      }, 2);
    }
    const result = await transcript.linesBySession(parsed.data);
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'lines-by-provider') {
    const parsed = ProviderName.safeParse(
      required(flags.provider, 'provider'),
    );
    if (!parsed.success) {
      fail({
        code: 'Usage',
        message: '--provider must be kimi, claude, or codex',
      }, 2);
    }
    const since = typeof flags.since === 'string'
      ? flags.since
      : undefined;
    const result = await transcript.linesByProvider(parsed.data, since);
    return result.ok ? output(result.value) : fail(result.error);
  }
  if (verb === 'subagent-tree') {
    const result = await transcript.subagentTree(
      required(flags.turn, 'turn'),
    );
    return result.ok ? output(result.value) : fail(result.error);
  }
  fail({
    code: 'Usage',
    message:
      'verbs: ingest | status | lines-by-session | lines-by-provider '
      + '| subagent-tree',
  }, 2);
}

void main();
