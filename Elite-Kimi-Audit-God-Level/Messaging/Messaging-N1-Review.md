# Messaging N1 (Foundation) — Law-#6 Review Record

**Date:** 2026-07-25 · **Auditor:** fresh 0-context adversarial subagent (explore type,
read-only enforced), briefed with the elite-codebase-engineering skill as the standard.
**Scope:** `git diff main...HEAD` on `kimi/n1-foundation` — cf688143 (D2 package move)
+ f023a115 (embed + adapters). First auditor of the N-program; baseline = the sealed
pass-2 program (PR #59).

## Auditor verdict

**Overall risk: moderate. Confidence: 90%.** Verdict: does not seal until the two
must-fix findings are disposed; substance judged good — "the seam contracts are
honored with unusual fidelity" (every load-bearing header claim verified against the
core: typed outcomes, R8 fresh resolution with §3.2.3 revision evidence, honest
failure mapping, sweep-before-serve, torn-tail recovery, 253/253 post-move).

The auditor independently re-ran: tsc, lint (ratchet holds), the three new test
files, objectModel.test.ts, package suite 253/253, drift guard NO DRIFT.

## Findings and dispositions

### MUST-FIX — disposed at source, regression-tested

1. **Partial-boot leak makes the "capability disabled" promise false (moderate).**
   `startMessagingV2` opened the store and started the sweep/bus timers before the
   guarded section; a late throw (e.g. the principal count read) leaked timers +
   the journal handle while the server logged "disabled".
   **Disposed:** pure adapters construct first, store second, everything that can
   throw post-construction sits inside `bootGuarded` (close-on-failure, close
   failure never masks the boot error). **Regression test:** the failed-boot
   teardown test in `messagingV2/index.test.ts` spies `setInterval`/`clearInterval`
   and asserts zero live timers after a rejected boot — shown FAILING (2 leaked)
   against the pre-fix code, PASSING after. (First attempt with
   `getActiveResourcesInfo` passed against the broken code — unref'd timers are
   invisible to it; replaced with the spy. Recorded so nobody "fixes" the test
   back to the weak form.)

2. **The `ws` bump invalidated every deploy snapshot and was unjustified by N1
   (moderate).** Nothing reachable from messagingV2 imports `ws`; the bump churned
   the lockfile, and `tools/deploy.mjs`'s dep-skew guard refuses to boot snapshots
   built against the old hash.
   **Disposed:** reverted — `ws` back to `^8.17.0` (installed 8.21.0), lockfile
   byte-identical to main. No live snapshot needs rebuild. Package keeps its own
   `ws ^8.21.1` + own lockfile for its standalone suite.

### Disposed at source in the same pass

3. **"Token = agentId is an unguessable uuid" (moderate, honesty).** Unguessable ≠
   secret — agentIds are observable identifiers. Header rewritten to state the
   honest posture: acceptable ONLY because N1 has no untrusted callers; N6 does
   real issuance; N2 must not expose authenticate to agentId-reading callers
   without a threat note.
4. **Chief grant from a bare display-name prefix (moderate).** Now word-bounded
   (`/^chief\b/i` — "chieftain" no longer asserts Chief). D4 stands (name
   conventions are the ratified v1 source); a durable-id-keyed role config is
   recorded as pre-N6 debt below.
5. **Session Map grew unboundedly (moderate-low).** Pruning added: expired/
   invalidated entries dropped at authenticate (the only growth point) and at
   revalidate's point of truth. Adapter-private `sessionCount()` test control;
   regression test in authority/index.test.ts. (The package's authority-config
   shares the defect class — recorded as program debt; the core is frozen.)
6. **`stop()` aborted on a v2 close failure (low-moderate).** Close is now
   try/caught, logged, shutdown continues.
7. **Lifecycle predicate triplicated (low).** One exported `isActiveAgent` shared
   by authority, membership, and the boot principal count.
9. **Roster not deduped (low).** `rosterOf` dedupes by personId
   (`ObjectModel.missionAgents` doesn't fold by id — the double-mint class).
   Regression test appends a duplicate agents.jsonl line and asserts the Person
   resolves exactly once.
13. **Plan said "ObjectModel + PeopleHub"; PeopleHub not wired (low).** Recorded
   amendment in the N1 row of Messaging-Integration-Plan.md: the authority
   adapter reads ObjectModel directly (an in-process HTTP hop to PeopleHub would
   be ceremony); PeopleHub's join/liveness rules remain the N4 read-side
   reference.
14. **`messaging:test` built the package twice (cosmetic).** Script now relies on
    the package's own pre-test build.
15. **CI didn't cache the package's deps (cosmetic).** `cache-dependency-path`
    now covers both lockfiles.

### Follow-up debt — scheduled, NOT blocking (recorded for N2/N6)

- **8.** ~60 lines of validation/derivation near-copied from the package's
  authority-config (which doesn't export them). Drift risk accepted for N1;
  if a second host adapter appears, push the shared helpers down into the
  package via a recorded amendment. Also: the copy drops per-principal
  `sessionTtlMs` — global TTL only in v1.
- **10.** `check-map-drift.mjs` reaches outside the package into
  `Elite-Kimi-Audit-God-Level/` (map stays with program docs). Renaming that
  folder reds the guard — noted in the handover.
- **11.** `millis()` throwing inside revalidate escapes the seam (session.ts
  awaits the guard outside its try) — only reachable with a broken clock
  (composition error); same latent shape in the package adapter.
- **12.** Every adapter call is a full `readStoreDir` disk scan — fine at N1;
  N2's presence heartbeats will make revalidate hot. Watch.
- **4 (residual).** Role-from-name-convention is ratified (D4) but fragile:
  a durable-id-keyed role config belongs in a near slice, before N6 opens the
  door.
- **3 (residual).** N2 threat note: `authenticate` must not be exposed to
  callers that can read agents.jsonl (token = identifier until N6).

## Gate evidence after disposal (re-run by the orchestrator, not the implementer)

- `npx tsc --noEmit` — OK
- messagingV2 index/authority/membership tests via tsx — PASS (incl. new
  regression tests: failed-boot teardown, session pruning, roster dedupe)
- `npm run lint` — 200 total, PASS (< baseline 201, zero net new warnings;
  the disposal refactors initially added 3 max-lines warnings, extracted
  helpers removed them)
- `npm run stores:test`, `npm run stores:gate` — PASS
- `npm run build` — OK
- `npm run messaging:test` — 253/253 + NO DRIFT
- Live scratch boot (earlier, pre-disposal wiring — unchanged since):
  `[messaging-v2] capability booted` confirmed, port cleaned up

Known pre-existing, unrelated: `src/backend/messaging/tests/api.test.ts` fails on
this machine (unpinned MailboxRegistry reads the Live lane's mailboxes.jsonl;
passes in CI's fresh checkout). Follow-up outside N1: pin `mailboxStorePath`
in that test.

## Verdict after disposal

Both must-fix findings disposed at source with regression tests shown to fail
before the fix; every low finding either fixed or recorded as scheduled debt.
**N1 seals.** Exit condition met: capability boots in-app, contract suite runs
in app CI (`.github/workflows/ci.yml` + `npm run messaging:test`), all gates green.
