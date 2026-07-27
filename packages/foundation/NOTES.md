# NOTES.md — packages/foundation (S1)

One-line notes where the contract was ambiguous or the simplest reading was chosen.

1. **CAS version lives in the record-line wrapper `meta.version`.** A §10 says the
   counter "lives on each appended line"; §11 ruling 2 fixes the wrapper as
   `{envelope, payload, meta:{opId, clientOpId}}`. `version` added inside `meta`
   (additive, envelope untouched).
2. **`createdBy` required in create payloads, value overridden.** FND-001 demands
   rejection when any of the 6 envelope fields is missing; §3 says payload is
   "full object incl. envelope, minus createdBy". Reading: the field must be
   present (FND-001 property test) but its caller value is never trusted and is
   always replaced by the token-derived principal (red gate 4).
3. **createObject on an existing id → `CasConflict` (expected 0, actual v).**
   The contract names no error for this; CAS is the closest typed shape and is
   retryable (re-read + updateObject).
4. **`Quarantined` error added to the StoreError union.** §11 ruling 5 names a
   `Quarantined` rejection for writes to quarantined ids, but §6's union doesn't
   include it — added additively.
5. **`unsupportedVersion` flag added to `StoredObject`.** §8 rule 3 requires
   reads of newer-version records to surface "with a meta.unsupportedVersion
   flag"; `StoredObject` has no meta field, so the flag is a top-level optional
   field (additive).
6. **updateObject preserves original `createdBy`/`createdAt`; patch cannot touch
   envelope identity fields.** The envelope is the creation record; update actors
   are attributed on the trace line (`createdBy` of the trace = caller principal).
7. **`.novakai/lock` is a lock DIRECTORY containing `owner.json`** (mkdir-based,
   pid-liveness takeover) — ported from audit-verified `src/backend/stores/store.mjs`
   (Delta-S2). The spec calls it a "lock file"; the proven pattern is a dir.
8. **Legacy engine harvested by pattern, not by import.** `src/backend/stores/*`
   is domain-specific (missions/tasks schema law, SC4/SC5 byte guards). The lock
   protocol and append discipline were ported; the new engine implements the
   Pass 2 wrapper/trace/CAS contract in TS. `src/` untouched; no new `.mjs`.
9. **Token grants = allowed kinds (S1 simplification per §11 ruling 1).** Grant
   registry moves to the agents capability in S2/S3; CLI handles bind
   `allowedKinds = token.grants`, capability `foundation`.
10. **Boot reconciliation is per-engine-instance, once.** Within a live process
    an incomplete object is readable with `incomplete:true` and retry-reconciled
    (R3-10); orphan tombstoning happens when a NEW engine instance boots (crash
    window semantics of §7.1). Boot is idempotent (no duplicate tombstones).
11. **Dual-read migration copies the legacy store file on first write** (lazy
    per-store migration, R3-21); the legacy root is left untouched. Shim removal
    is NOT implemented — gated on a provably-empty old root, no store is proven
    migrated yet.
12. **`queryTrace`/`listQuarantine` keep the §3 handle-free signatures** backed
    by an ambient default root (`NOVAKAI_ROOT` or `./.novakai`); bound variants
    `queryTraceBound`/`listQuarantineBound(engine, ...)` are what the CLI and
    composed consumers use.
13. **No npm workspace config exists at repo root**, so packages/foundation is
    self-contained (own package.json, own node_modules, zod dependency local).
