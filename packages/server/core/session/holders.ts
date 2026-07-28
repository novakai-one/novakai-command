// packages/server/core/session/holders.ts — the messaging session layer
// (DEC-B1-6, §13 disposition 11).
//
// Messaging sessions expire (v1 TTL: 1h) and the config authority has no
// refresh, so a long-lived server that holds a session object dies with
// "NotAuthenticated: session is no longer valid". The demo proved the fix
// (sessCall/SessionHolder); B1a makes it STRUCTURAL:
//
//   - the factory is the only source of holders;
//   - a holder exposes call(op) and nothing else — there is no accessor that
//     returns the raw MessagingSession;
//   - so "a messaging call outside the re-auth wrapper" (red gate 5) cannot be
//     written, rather than merely being against the rules.
//
// On a typed auth failure the holder re-authenticates with the principal's
// token and retries the operation exactly once. Anything else — a domain error,
// a failed re-auth — comes back to the caller as the typed value it already is.

/** The shape of a messaging session we need: opaque, passed straight to ops. */
export type MessagingSessionLike = object;

export type AuthOutcomeLike =
  | { kind: 'authenticated'; session: MessagingSessionLike }
  | { kind: string };

export type AuthenticateFn = (credential: { token: string }) => Promise<AuthOutcomeLike>;

/**
 * The messaging capability, as the factory needs it. Taking the capability
 * (rather than a plucked-off function) means the composition root never has to
 * touch `.authenticate` itself — the only call site in the whole server is
 * inside this module.
 */
export interface AuthenticatingCapability {
  authenticate(credential: { token: string }): Promise<AuthOutcomeLike>;
}

export interface PrincipalCredential {
  token: string;
  personId: string;
}

export interface MessagingSessionHolder {
  readonly personId: string;
  /**
   * Run one operation against this principal's live session. On a typed auth
   * failure the session is renewed and the operation retried ONCE.
   */
  call<T>(op: (session: MessagingSessionLike) => Promise<T>): Promise<T>;
}

export interface HolderError {
  code: 'AuthFailed';
  message: string;
}

export type HolderResult<T> = { ok: true; value: T } | { ok: false; error: HolderError };

export interface SessionHolderFactory {
  /** The ONLY way to obtain a usable messaging session in this process. */
  holderFor(credential: PrincipalCredential): Promise<HolderResult<MessagingSessionHolder>>;
  /** personIds we currently hold sessions for (boot tracing, supervision). */
  principals(): string[];
}

/** A typed messaging auth failure, in the shape messaging returns. */
export function isAuthFailure(result: unknown): boolean {
  const r = result as { kind?: string; error?: { name?: string; message?: string } };
  return r?.kind === 'error'
    && /NotAuthenticated|no longer valid/i.test(`${r.error?.name ?? ''} ${r.error?.message ?? ''}`);
}

export function createSessionHolderFactory(
  deps: { authenticate: AuthenticateFn } | { messaging: AuthenticatingCapability },
): SessionHolderFactory {
  const holders = new Map<string, MessagingSessionHolder>();
  const authenticate: AuthenticateFn = 'messaging' in deps
    ? (credential) => deps.messaging.authenticate(credential)
    : deps.authenticate;

  return {
    async holderFor(credential) {
      const existing = holders.get(credential.personId);
      if (existing) return { ok: true, value: existing };

      const first = await authenticate({ token: credential.token });
      if (first.kind !== 'authenticated') {
        return {
          ok: false,
          error: {
            code: 'AuthFailed',
            message: `could not authenticate principal "${credential.personId}" (${first.kind})`,
          },
        };
      }
      // `session` is private to this closure: nothing else can reach it.
      let session = (first as { session: MessagingSessionLike }).session;

      const holder: MessagingSessionHolder = {
        personId: credential.personId,
        async call<T>(op: (s: MessagingSessionLike) => Promise<T>): Promise<T> {
          const attempt = await op(session);
          if (!isAuthFailure(attempt)) return attempt;
          const renewed = await authenticate({ token: credential.token });
          if (renewed.kind !== 'authenticated') return attempt; // typed failure, never a throw
          session = (renewed as { session: MessagingSessionLike }).session;
          return op(session);
        },
      };
      holders.set(credential.personId, holder);
      return { ok: true, value: holder };
    },

    principals() {
      return [...holders.keys()];
    },
  };
}
