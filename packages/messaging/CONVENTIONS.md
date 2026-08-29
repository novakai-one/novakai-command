# Messaging — Conventions

Breaking a rule gets code sent back — no exceptions, no matter who wrote it.

## 1. Expected failures are typed values, never strings

Callers branch on a kind; nobody parses a message.

```ts
// bad — the reader must parse "code: message" text to know what happened
failure?: string;

// good — the shape itself says what happened
failure?: { kind: 'send-rejected'; rejection: SendRejection }
        | { kind: 'dispatch-failed'; detail: string };
```

## 2. One entry point per capability

Callers never wire the steps themselves; the module hides the coordination.

```ts
// bad — every caller must remember to journal before dispatching
const journal = await acceptSend(deps, input);
await dispatchAcceptedSend(deps, journal);

// good — one call, coordination hidden inside
const result = await sendConversationMessage(deps, input);
```

## 3. Ports are narrow and owned by the consumer

A module declares the smallest interface it needs, not the fat store it
happens to be given.

```ts
// bad — drags in ~20 methods to use 1
constructor(private store: TranscriptStore) {}

// good — the consumer says exactly what it needs
interface AgentLookup { get(id: string): Promise<AgentDirectoryEntry | undefined>; }
```

## 4. Branded IDs are minted in one checked module

Validation lives in `mint.ts`; everywhere else the type guarantees validity.

```ts
// bad — a cast that promises nothing
const id = raw as PendingDeliveryId;

// good — the only place the check lives; drift throws
const id = mintPendingDeliveryId(lineId, recipientAgentId);
```

## 5. Optional fields are absent, never explicitly undefined

The repo compiles with `exactOptionalPropertyTypes`; use `present()`.

```ts
// bad — writes { failure: undefined } into the record
{ ...delivery, failure: maybeReason }

// good — key exists only when there is a value
{ ...delivery, ...present('failure', maybeFailure) }
```

## 6. Docs name the crash-recovery owner

Every entry point's TSDoc says what happens if the process dies mid-step and
who catches store/provider explosions. An overclaiming doc is worse than none.

## 7. Functions read as a story; complexity stays at 0–3

Guard clauses over ternaries-in-return; named helpers over inline cleverness.
If a function needs a paragraph to explain, it is two functions.
