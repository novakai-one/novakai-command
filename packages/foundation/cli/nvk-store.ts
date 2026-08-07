#!/usr/bin/env node
// nvk-store — every foundation contract op exposed as a verb (FND-007, DEC-F11).
// Thin adapter: each verb calls the SAME contract function as in-process callers.
// Auth: bearer token from .novakai/tokens/ via --token or NOVAKAI_TOKEN (R3-5/R3-6);
// the token's principal is the ONLY createdBy source (red gate 4).
// Exit codes: 0 ok · 1 typed contract error · 2 usage/auth failure.
// Output: single JSON Result line on stdout, always.
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  composeHandle, createObject, updateObject, getObject, listObjects, resolveRef,
  queryTraceBound, listQuarantineBound, resolveQuarantine,
  mintClientOpId, mintToken, authenticate,
  type ClientOpId, type ObjectId, type ObjectKind,
} from '../contract/index.js';
// M11: foundation-internal CLI may use the raw engine factory directly.
import { composeEngine } from '../contract/compose.js';

interface Args { [k: string]: string | boolean | undefined }

function parseArgs(argv: string[]): { verbs: string[]; opts: Args } {
  const verbs: string[] = [];
  const opts: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i += 1; }
    } else {
      verbs.push(a);
    }
  }
  return { verbs, opts };
}

function out(value: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exit(code);
}

function usage(): never {
  process.stderr.write([
    'nvk-store — foundation contract CLI (parity with in-process ops)',
    '  token mint --principal <id> --grants <kind,kind...> [--actor <id>]',
    '  create --data <json> --client-op-id <op_...>',
    '  update --id <objectId> --patch <json> --expected-version <n> --client-op-id <op_...>',
    '  get --kind <kind> --id <objectId>',
    '  list --kind <kind> [--filter <json>] [--cursor <c>] [--limit <n>]',
    '  resolve-ref --kind <kind> --id <objectId>',
    '  trace query [--op-id <srv_...>] [--client-op-id <op_...>] [--target-kind <k> --target-id <id>] [--since <iso>]',
    '  quarantine list',
    '  quarantine resolve --id <tombstoneId> --resolution reconcile|dismiss --client-op-id <op_...>',
    'flags: --root <dir> (default .novakai) · --token <bearer> (or NOVAKAI_TOKEN)',
  ].join('\n') + '\n');
  process.exit(2);
}

async function main(): Promise<void> {
  const { verbs, opts } = parseArgs(process.argv.slice(2));
  const root = path.resolve(String(opts.root ?? '.novakai'));
  const [noun, verb] = verbs;

  // token mint needs no bearer (local human at the repo — §11 ruling 1)
  if (noun === 'token' && verb === 'mint') {
    const principal = String(opts.principal ?? '');
    const grants = String(opts.grants ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!principal || grants.length === 0) usage();
    const token = mintToken(root, principal, grants, String(opts.actor ?? 'person_local'));
    out({ ok: true, value: { id: token.id, principal: token.principal, grants: token.grants, bearer: token.bearer } });
  }

  // every other verb requires bearer auth against .novakai/tokens/
  const bearer = String(opts.token ?? process.env.NOVAKAI_TOKEN ?? '');
  if (!bearer) {
    process.stderr.write('auth: provide --token <bearer> or NOVAKAI_TOKEN\n');
    process.exit(2);
  }
  const token = authenticate(root, bearer);
  if (!token) {
    out({ ok: false, error: { code: 'AuthFailed', message: 'bearer token not recognized', details: { cause: 'unknown bearer' }, retryable: false } }, 1);
  }
  const grants = token!.grants as ObjectKind[];
  const handle = composeHandle({
    root, capability: 'foundation', allowedKinds: grants, principal: token!.principal,
  });
  const engine = composeEngine({ root, capability: 'foundation', allowedKinds: grants, principal: token!.principal });

  const fail = (error: unknown) => out({ ok: false, error }, 1);
  const succeed = (value: unknown) => out({ ok: true, value }, 0);

  if (noun === 'create' || (noun === undefined && verb === undefined)) {
    // allow bare verbs: create/update/get/list
  }

  const name = noun === 'quarantine' || noun === 'trace' ? `${noun} ${verb}` : noun;

  switch (name) {
    case 'create': {
      if (!opts.data || !opts['client-op-id']) usage();
      const res = await createObject(handle, JSON.parse(String(opts.data)), String(opts['client-op-id']) as ClientOpId);
      return res.ok ? succeed(res.value) : fail(res.error);
    }
    case 'update': {
      if (!opts.id || !opts.patch || opts['expected-version'] === undefined || !opts['client-op-id']) usage();
      const res = await updateObject(
        handle, String(opts.id) as ObjectId, JSON.parse(String(opts.patch)),
        Number(opts['expected-version']), String(opts['client-op-id']) as ClientOpId,
      );
      return res.ok ? succeed(res.value) : fail(res.error);
    }
    case 'get': {
      if (!opts.kind || !opts.id) usage();
      const res = await getObject(handle, String(opts.kind) as ObjectKind, String(opts.id) as ObjectId);
      return res.ok ? succeed(res.value) : fail('unreachable');
    }
    case 'list': {
      if (!opts.kind) usage();
      const res = await listObjects(
        handle, String(opts.kind) as ObjectKind,
        opts.filter ? JSON.parse(String(opts.filter)) : undefined,
        { cursor: opts.cursor ? String(opts.cursor) : undefined, limit: opts.limit ? Number(opts.limit) : undefined },
      );
      return res.ok ? succeed(res.value) : fail(res.error);
    }
    case 'resolve-ref': {
      if (!opts.kind || !opts.id) usage();
      const res = await resolveRef(handle, { kind: String(opts.kind), id: String(opts.id) });
      return res.ok ? succeed(res.value) : fail('unreachable');
    }
    case 'trace query': {
      const page = await queryTraceBound(engine, {
        opId: opts['op-id'] as never,
        clientOpId: opts['client-op-id'] as never,
        target: opts['target-kind'] && opts['target-id']
          ? { kind: String(opts['target-kind']), id: String(opts['target-id']) } : undefined,
        since: opts.since ? String(opts.since) : undefined,
      });
      return succeed(page);
    }
    case 'quarantine list': {
      const page = await listQuarantineBound(engine);
      return succeed(page);
    }
    case 'quarantine resolve': {
      if (!opts.id || !opts.resolution || !opts['client-op-id']) usage();
      const res = await resolveQuarantine(
        handle, String(opts.id) as ObjectId,
        String(opts.resolution) as 'reconcile' | 'dismiss',
        String(opts['client-op-id']) as ClientOpId,
      );
      return res.ok ? succeed(res.value) : fail(res.error);
    }
    default:
      usage();
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  process.exit(2);
});
