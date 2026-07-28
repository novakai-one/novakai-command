# Server Notes

## Follow-ups B1b

- Check and surface the results of `closeSession` and `setContactPolicy`.
- Replace `isAuthFailure` message-string sniffing with a typed discriminator.
- Define collision handling for `byPerson` instead of retaining the last thread encountered.
- Move `.watchdog-sessions.json` under the `.novakai/` runtime store.
- Replace deep `dist/contract` import styles with stable package subpath exports.
- Reconcile the provisioned principal and binding when an agent conversation is created but never sent.

## B1b — supervision (§8)

- **Trace action enum is CLOSED, so supervision rides `hook_log`.** Foundation
  accepts `'hook_log' | 'context.inject' | 'hook_error' | 'session.terminate'`.
  DEC-B1-15 requires every supervision action to be a `system.action` trace, so
  gate/drift/ping/restart/compact/usage are appended as `hook_log` with
  `meta.event` naming them; `session.terminate` keeps its own action. Widening
  the enum to first-class supervision actions is a foundation SCHEMA AMENDMENT
  and is recorded here as a ratification candidate rather than smuggled in.
- **Transcript custody copies are preferred, with provider-original fallback.**
  Supervision discovers `.novakai/transcripts/` first and also discovers the
  providers' original read-only transcript files. It selects the newest
  candidate for the conversation. This makes B1b copy backfill work without
  making accounting depend on the transcript watcher, which remains OFF by
  default because B1a measured it starving the HTTP loop at real volume.
  Provider formats and path rules stay in the agents provider capability;
  the server consumes them through the agents contract.
- **Undeclared sessions bill in full — the default is inverted on purpose.**
  A live run on 2026-07-28 reported `in=0 out=0` for a codex session that had
  really spent 41,814 tokens: nothing declared the freshly-spawned session to
  the usage reader, so it took its baseline at first read. The silent
  undercount was invisible. An undeclared session is now a fresh thread
  (baseline 0); ADOPTION is the case that must be declared, and boot declares
  it for every session it reattaches. Over-attribution is at least visible in
  the row's note; an undercount of real money is not.
- **`getUsageTable` reports `null`, never `0`, for an unmeasurable session,**
  and the row carries the reason. The shell renders null as an em dash and
  skips it in totals, so the screen can never claim a session cost nothing.

## Follow-ups after B1b

- Provider-level supervision config (per-provider drift/idle policy) is one
  global policy today.
- `compactSession` is restart-fresh for all three providers; if a provider ever
  declares a native compact, `respawn` is the one place that changes.
- The gate's skill paths come from the registered skills registry at BOOT; a
  skill registered later is not demanded until the next boot.

## Follow-ups Build 2

- Route `terminateSession` through supervision so engine cleanup is not bypassed.
- Mark supervision-originated sends in the providerSession in-flight queue.
- Reject skills-gate markers preceded by leading blank lines.
- Make `resolveCliPath` validate the exact executable path later spawned instead of a divergent `PATH` lookup.
- Give usage drift and offline states distinct icons.
