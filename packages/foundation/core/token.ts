// Token records — .novakai/tokens/<id>.json, one file per token (R3-5/R3-6, A §8).
// §11 ruling 1: S1 ships foundation-local `token mint` with grants inline;
// the spine-workflow version (grants in agents capability) lands in S3.
// v1: bearer, long-lived, revocable by file deletion. createdBy source = principal.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TokenRecord } from '../contract/schemas.js';
import type { TokenRecord as TokenRecordT } from '../contract/schemas.js';

export function tokensDir(root: string): string {
  return path.join(root, 'tokens');
}

export function mintToken(
  root: string,
  principal: string,
  grants: string[],
  actor: string,
): TokenRecordT {
  const token = TokenRecord.parse({
    kind: 'token',
    id: `token_${randomUUID()}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: 'private',
    createdBy: actor,
    principal,
    grants,
    bearer: `nvk_${randomUUID().replaceAll('-', '')}`,
  });
  const dir = tokensDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${token.id}.json`), JSON.stringify(token, null, 2) + '\n');
  return token;
}

export function loadTokens(root: string): TokenRecordT[] {
  const dir = tokensDir(root);
  if (!existsSync(dir)) return [];
  const out: TokenRecordT[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const parsed = TokenRecord.safeParse(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
      if (parsed.success) out.push(parsed.data);
    } catch { /* unreadable token file — skipped, never trusted */ }
  }
  return out;
}

/** Bearer-token auth (R3-5/R3-6): token → exactly one principal + its grants. */
export function authenticate(root: string, bearer: string): TokenRecordT | null {
  return loadTokens(root).find((t) => t.bearer === bearer) ?? null;
}
