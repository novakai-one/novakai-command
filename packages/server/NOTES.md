# Server Notes

## NVK-KIMI-005 Build 2a handoff — 2026-07-29

The remaining builder window before the six-hour ceiling was insufficient to
start and verify Server composition after Projects, Artifacts, and Spine were
implemented and independently approved. Work stopped before creating a
partial Server slice. Do not reopen those capabilities unless integration
exposes a concrete contract defect.

- Approved integration base: `0d9c6ed169d72e4d4ea6ed612adcc14d60ae2313`
- Projects approved through `83382d03ddbf358778d38451a96af86f83ba3083`
  (`24/24`)
- Artifacts approved through `6bea71074a75433a29fa567b862e64cbd41bd268`
  (`37/37`)
- Spine approved through `0d9c6ed169d72e4d4ea6ed612adcc14d60ae2313`
  (`44/44`; cross-package verification `410/410`)
- Only pending Build 2a slice: compose these capabilities in Server; add real
  traced boot steps, non-byte WS methods, authenticated loopback Artifact
  POST/GET, the `nvk project|artifact|spine` umbrella CLI, and the headless
  second-host proof.
- Preserve the red gates: `projects.attach` remains Spine-only; no Artifact
  bytes in WS/JSONL/trace; no Shell feature changes; every effect follows a
  durable accepted Spine fact.
- The pre-existing untracked `.watchdog-sessions.json.prev.json` is unrelated
  and must remain untouched.
- Continuation brief and exact commands:
  `/tmp/NVK-KIMI-005-B2a-server-handoff.md`

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
