# Messaging core/ inventory — transcript-first (A) vs old messaging spec (B)

Date: 2026-08-28 · branch `core-inventory` (worktree, read-only audit)
Source: full read of all 43 `.ts` files under `packages/messaging/core/` + contract-layer orientation.

**Tally: 27 files implement the intended transcript-first model (A). 16 files implement the old DEC-spec messaging system (B). Zero files mix the two.**

## Why agents got 0% accuracy

The B files are the big, loud ones at the root of `core/` (`decideSend.ts` 20KB, `subscriptions.ts` 28KB, `validate.ts` 22KB…). An agent lands there, reads carefully, and reports the old system (Threads, DND, Presence, CAS state machines) as "how messaging works". The real transcript-first system lives quietly in subdirectories (`ingestion/`, `send/`, `delivery/`, `conversations/`).

## Delete as a unit — the 16 B files (old system)

These form a closed subgraph: they only import each other + B contract ports/schemas.

- `decideSend.ts` — old send-policy decision point (Threads/DND/ContactPolicy)
- `sendPipeline.ts` — old send choreography (commitAcceptance, template door)
- `deliveryOrchestrator.ts` — old R5 delivery state machine
- `validate.ts` — old door parsers (SendMessage/DND/ContactPolicy/Template/Subscribe)
- `templates.ts` — template sends into the old pipeline
- `subscriptions.ts` — push subscriptions over old journal events
- `storeErrors.ts` — old store-seam error mapping
- `session.ts` — old Principal revalidation state machine
- `requestHash.ts` — old A5 request hashing
- `recoverySweep.ts` — old effectsPending sweep
- `queries.ts` — the 9 old contract queries (GetThread/GetInbox/GetPolicy…)
- `presenceRegistry.ts` — old ephemeral Presence registry
- `presenceCommands.ts` — old OpenPresence/ClosePresence
- `policyCommands.ts` — old SetDndPolicy/SetContactPolicy
- `journalProjection.ts` — old journal→event mapping
- `eventBus.ts` — old journal-sourced bus (**duplicate of the A bus**)

⚠️ Before deleting: verify no composition root outside `core/` still imports these. Also the B-side contract ports/schemas (`contract/ports/store.ts`, `authority.ts`, `membership.ts`, `presence-transport.ts`, B types in `schemas.ts`) become dead once these go.

## Keep — the 27 A files (your transcript-first model)

All present, all matching the data-model diagram:

- **Ingestion (one door):** `ingestion/` — watch, ingest, ingest-queue, select-sources, normalize-growth, ingest-records (checkpoint + dedupe), reconcile, classify-session (identity-hook evidence), assign-session, adopt-session
- **Send:** `send/` — accept (idempotent SendJournal), dispatch (one effect via ProviderSend port), confirm (transcript-only reconciliation), send
- **Delivery Router:** `delivery/` — router (idle-boundary claims), transitions (queued→…→transcript-observed), addressed-delivery-reconciler, delivery-marker-codec
- **App view:** `conversations/` — views, messages, message-stream, directory
- **Projections (rebuildable):** `projections/rebuild.ts` (usage rollups + tool-call index)
- **Runtime/queries:** `runtime/committed-records.ts`, `communications/queries.ts`
- **Bus:** `event-bus.ts` (DurableTranscriptEventBus — keep this one, delete `eventBus.ts`)

## Model coverage vs the diagram

Every intended capability exists in core/: ingestion-as-only-reader, transcript root store, all six entities, delivery router with idle gating, identity-hook consumer, rebuildable projections. The only out-of-scope pieces (one-shot CLI adapter, hook emitter) are ports/adapters by design — they live outside this package.

## Cosmetic residue (optional later cleanup)

- `communications/queries.ts` mints `thread_transcript-…` fallback ids / exposes `threadId` fields — old-system vocabulary inside an A file
- `delivery/delivery-marker-codec.ts` permits an optional `threadId`
- B-era vocabulary in otherwise pure-A files; rename when convenient, not urgent
