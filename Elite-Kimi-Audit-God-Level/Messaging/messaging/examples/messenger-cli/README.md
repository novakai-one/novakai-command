# messenger-cli — the Messaging capability's second host (Plan §15 P1)

A standalone terminal messenger application. It exists to prove **second-host
composability** (red gate G13, MSG-022): a host that is not Novakai Command can
use the Messaging capability end-to-end **importing no private code and
requiring no change to the Messaging core**.

## Identity provisioning (the v1 interface)

The app holds only two things, exactly like a real external host:

- a **server URL** (`--url ws://host:port`), and
- a **bearer token** (`--token`).

Provisioning happens at the **standalone server's authority config** — the v1
provisioning interface. An operator maps `token → Person ID → roles` in that
config (DEC-07: the role→grant mapping lives in adapter config, never in the
Messaging core, and never in this app). The app learns its own Person ID from
the authentication handshake; it never constructs or asserts an identity.

## What the app speaks

Only the published **DEC-17 JSON-over-WebSocket protocol**
(`protocolVersion 1.0.0`):

```
client → server   get-capabilities · authenticate · command · query · subscribe · unsubscribe
server → client   capabilities · authenticated · command-result · query-result ·
                  delivery (ADDRESSED lane) · error · started/event/ended (OBSERVATION lane)
```

The app's only dependency is `ws`. It imports **nothing** from the Messaging
package — not even its public surface (an architecture test in the Messaging
package scans this directory and asserts exactly that).

## Its own UI from published projections

The app maintains local projections — inbox, thread history, presence — built
**only** from query results and pushed frames, and renders plain-text views
from them. Every rendered line is tagged with the source that put it there:

- `[pushed]` — arrived via a pushed delivery frame or subscription event
  (MSG-023: the anti-polling law — no query was issued to learn of it);
- `[pulled]` — arrived via an explicit `sync-*` catch-up query (the reconnect
  fallback, never the liveness mechanism).

`stats` reports how many queries of each kind the app has issued, so a driver
can prove a rendered view reflects Messaging state with zero polls.

## Running

```sh
npm install          # ws only
node app.mjs --url ws://127.0.0.1:8787 --token tok-alice --name alice
```

The app authenticates, prints `READY <personId>`, then reads JSON-lines
commands from stdin (see the header comment in `app.mjs` for the command
vocabulary). It is script-driven, not interactive; the P1 proof
(`messaging/tests/standalone/p1-messenger-app.test.ts`) drives it as a child
process.

## Known example-scope limitations

Recorded at the S3 audit — acceptable for a proof-harness host, not
production-grade: unmatched frames accumulate unbounded; pushed subscription
`ended` notices are not surfaced; server death mid-session degrades to
per-command timeouts rather than a reported disconnection.
