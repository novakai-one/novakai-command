#!/usr/bin/env -S npx tsx
// nvk-token — OFFLINE cold-start CLI (§6, §13 disposition 4).
//
// Runs with NO server: it contends on foundation's global mutation lock
// directly, so the first-boot runbook is
//
//     nvk-token mint person_chris --roles Human    # mint Chris + config line
//     nvk-server                                   # boot against that config
//
// Verbs:  mint <principalId> --grants <kind,...> [--roles a,b]   |   list
//
// `grants` are FOUNDATION object kinds (the store scope the token may write) —
// required, never defaulted: guessing a principal's write scope is exactly the
// kind of invention §6 forbids. `roles` are MESSAGING role assertions, resolved
// to grants by the authority adapter's role→grant config.
// Root:   NOVAKAI_ROOT (default ./.novakai)
//
// The bearer secret is printed EXACTLY once (at mint) and never again: it lives
// in `.novakai/tokens/<id>.json`, referenced from config by id (red gate 1).
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';

const USAGE = `usage: nvk-token mint <principalId> --grants <kind,...> [--roles a,b]
       nvk-token list`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function main(argv: string[]): Promise<number> {
  const verb = argv[0];
  const root = process.env.NOVAKAI_ROOT ?? path.join(process.cwd(), '.novakai');

  if (verb !== 'mint' && verb !== 'list') {
    console.error(USAGE);
    return 2;
  }
  // A malformed mint must write NOTHING — validate before the store is opened,
  // because opening materializes config defaults.
  const principalId = argv[1];
  const roles = csv(flag(argv, 'roles'));
  const grants = csv(flag(argv, 'grants'));
  if (verb === 'mint') {
    if (!principalId || principalId.startsWith('--')) {
      console.error(`${USAGE}\nerror: mint needs a principal id (e.g. person_chris)`);
      return 2;
    }
    if (grants.length === 0) {
      console.error(`${USAGE}\nerror: mint needs --grants (foundation object kinds this token may write)`);
      return 2;
    }
  }

  const opened = await openConfigStore({ root, principal: 'sys_spine' });
  if (!opened.ok) {
    console.error(`nvk-token: config store unavailable — ${opened.error.message}`);
    return 1;
  }
  const store = opened.value;

  if (verb === 'list') {
    const cfg = store.current();
    for (const p of cfg.principals) console.log(`${p.personId}\troles=${p.roles.join(',') || '-'}\ttoken=${p.tokenId}`);
    for (const p of cfg.unresolvedPrincipals) console.log(`${p.personId}\tUNRESOLVED\t${p.reason}`);
    if (cfg.principals.length === 0 && cfg.unresolvedPrincipals.length === 0) console.log('(no principals configured)');
    return 0;
  }

  const token = store.mintPrincipalToken({ personId: principalId!, roles, grants });
  const written = await store.set(
    { configKind: 'principal', personId: principalId!, roles, tokenId: token.id },
    mintClientOpId(),
  );
  if (!written.ok) {
    console.error(`nvk-token: config write failed — ${written.error.message}`);
    return 1;
  }
  console.log(`minted ${token.id} for ${principalId} (roles: ${roles.join(',') || '-'})`);
  console.log(`bearer: ${token.bearer}`);
  console.log('store this now — it is printed once and lives only in .novakai/tokens/');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { console.error(`nvk-token: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; },
);
