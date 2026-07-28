// B1a slice 5 — the messaging session layer (DEC-B1-6, §13 disposition 11).
//
// The 1h-TTL death bug class dies here, and it dies STRUCTURALLY: a holder is
// the only thing you can obtain, and a holder only lets you RUN an operation.
// There is no way to get a bare MessagingSession out of the factory, so
// "a messaging call outside the re-auth wrapper" (red gate 5) is
// unrepresentable rather than merely discouraged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionHolderFactory, type AuthenticateFn } from '../core/session/holders.js';

const authFailure = { kind: 'error', error: { name: 'NotAuthenticated', message: 'session is no longer valid' } };
const okResult = (value: unknown) => ({ kind: 'ok', value });

/** A messaging stand-in whose sessions expire on demand — the real failure mode. */
function fakeMessaging(options: { expireAfter?: number; failReauth?: boolean } = {}) {
  let issued = 0;
  const calls: string[] = [];
  const authenticate: AuthenticateFn = async ({ token }) => {
    if (options.failReauth && issued > 0) return { kind: 'rejected' as const };
    issued += 1;
    const generation = issued;
    let used = 0;
    return {
      kind: 'authenticated' as const,
      session: {
        async listThreadsForPerson() {
          used += 1;
          calls.push(`gen${generation}:${token}`);
          if (options.expireAfter !== undefined && used > options.expireAfter) return authFailure;
          return okResult({ generation });
        },
      } as never,
    };
  };
  return { authenticate, calls, generations: () => issued };
}

test('a holder runs operations on a live session', async () => {
  const messaging = fakeMessaging();
  const factory = createSessionHolderFactory({ authenticate: messaging.authenticate });
  const holder = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  assert.equal(holder.ok, true);
  if (!holder.ok) return;

  const res = await holder.value.call((s) => (s as never as { listThreadsForPerson(): Promise<unknown> }).listThreadsForPerson());
  assert.deepEqual(res, okResult({ generation: 1 }));
  assert.equal(holder.value.personId, 'person_chris');
});

test('an expired session re-authenticates and retries ONCE — the 1h TTL death is gone', async () => {
  const messaging = fakeMessaging({ expireAfter: 1 });
  const factory = createSessionHolderFactory({ authenticate: messaging.authenticate });
  const holder = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  assert.equal(holder.ok, true);
  if (!holder.ok) return;
  const run = () => holder.value.call((s) => (s as never as { listThreadsForPerson(): Promise<unknown> }).listThreadsForPerson());

  assert.deepEqual(await run(), okResult({ generation: 1 }), 'first call is on the original session');
  assert.deepEqual(await run(), okResult({ generation: 2 }), 'the expired call is retried on a fresh session');
  assert.equal(messaging.generations(), 2, 'exactly one re-authentication');
});

test('a failure that is not an auth failure is returned as-is: no reauth, no retry', async () => {
  const messaging = fakeMessaging();
  const factory = createSessionHolderFactory({ authenticate: messaging.authenticate });
  const holder = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  assert.equal(holder.ok, true);
  if (!holder.ok) return;

  const domainError = { kind: 'error', error: { name: 'UnknownRecipient', message: 'nope' } };
  const res = await holder.value.call(async () => domainError);
  assert.deepEqual(res, domainError);
  assert.equal(messaging.generations(), 1, 'a domain error never burns a re-auth');
});

test('when re-authentication itself fails the caller gets the typed auth failure, never a throw', async () => {
  const messaging = fakeMessaging({ expireAfter: 0, failReauth: true });
  const factory = createSessionHolderFactory({ authenticate: messaging.authenticate });
  const holder = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  assert.equal(holder.ok, true);
  if (!holder.ok) return;

  const res = await holder.value.call((s) => (s as never as { listThreadsForPerson(): Promise<unknown> }).listThreadsForPerson());
  assert.deepEqual(res, authFailure, 'the original typed failure survives — the server decides what to do');
  assert.equal(messaging.generations(), 1);
});

test('one holder per principal, vended only by the factory', async () => {
  const messaging = fakeMessaging();
  const factory = createSessionHolderFactory({ authenticate: messaging.authenticate });
  const a = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  const b = await factory.holderFor({ token: 't1', personId: 'person_chris' });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value, b.value, 'the same principal gets the same holder');
  assert.equal(messaging.generations(), 1, 'no second authentication for a principal we already hold');
  assert.equal('session' in (a.value as unknown as Record<string, unknown>), false,
    'a holder never exposes the raw session — call() is the only way in');
  assert.deepEqual(factory.principals(), ['person_chris']);
});

test('an unauthenticatable principal is a typed refusal at the factory', async () => {
  const factory = createSessionHolderFactory({ authenticate: async () => ({ kind: 'rejected' as const }) });
  const holder = await factory.holderFor({ token: 'bad', personId: 'person_ghost' });
  assert.equal(holder.ok, false);
  if (holder.ok) return;
  assert.match(holder.error.message, /person_ghost/);
});

test('RED GATE 5 (mechanism, not discipline): nothing in the server calls authenticate() outside the holder factory', () => {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === 'node_modules' || entry === 'tests') continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.ts')) continue;
      // holders.ts vends every session; authority.ts IS the messaging authority
      // adapter (its authenticate answers messaging core, it never hands a
      // session to server code). Every other file must go through a holder.
      if (full.endsWith(path.join('core', 'session', 'holders.ts'))) continue;
      if (full.endsWith(path.join('core', 'session', 'authority.ts'))) continue;
      const source = readFileSync(full, 'utf8');
      if (/\.authenticate\s*\(/.test(source)) offenders.push(path.relative(serverRoot, full));
    }
  };
  walk(serverRoot);
  assert.deepEqual(offenders, [],
    'messaging sessions are vended ONLY by the holder factory (§13 disposition 11)');
});
