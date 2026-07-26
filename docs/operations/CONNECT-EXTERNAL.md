# Connect an External Agent (D-N6-1..3)

How an agent on a **foreign machine** joins the fleet messaging: connect,
authenticate, message — no manual step beyond issuing its token.

## The two commands

On the machine running the Novakai-Command backend (localhost), issue a
token for the durable agent:

```sh
node scripts/nvk-agent.mjs token issue --agent agent_<uuid>
# prints nvkt_<64 hex> EXACTLY ONCE — hash-only at rest afterwards;
# a lost token means revoke + re-issue, never a lookup
```

On the foreign machine (or anywhere that can reach the door), connect:

```sh
node scripts/nvk-connect.mjs --url ws://<host>:3032 --token nvkt_…
```

stdin takes JSON lines `{"to":"agent_<id>","body":"…","priority":"urgent"?}`
(`person:person_…` / `thread:thread_…` addresses work verbatim); pushed
messages, deliveries, and send results print as JSON lines on stdout. The
client re-authenticates and re-subscribes from its last sequence after any
session expiry or disconnect — a long-lived external never silently dies.

## The door (D-N6-1)

The backend serves the DEC-17 frames protocol (the same wire the capability's
standalone mode speaks) on a third listener: **port 3032, bound to
127.0.0.1 by default** — the localhost posture is unchanged; nothing external
reaches it until you opt in.

- `NVK_MESSAGING_V2_DOOR_PORT` — change the port.
- `NVK_MESSAGING_V2_DOOR_HOST` — change the bind. **Remote reachability is
  the owner's opt-in**: bind `0.0.0.0` yourself, or (better) keep localhost
  and reach it through an SSH or Tailscale tunnel. **There is NO TLS in N6 —
  tokens over plaintext ws are the owner's call**; a tunnel gives you
  encryption for free.
- Scratch backends (`NOVAKAI_SERVER_PORT` set) stay doorless so parallel
  rigs never fight over the port.

## Tokens (D-N6-2)

- Format `nvkt_<64 hex>` (256-bit random); the store
  (`.novakai-command/messaging-v2/tokens.jsonl`, chmod 600, gitignored)
  keeps only the SHA-256 hash.
- `token list --agent <id>` — ids/created/revoked (NEVER the token).
- `token revoke --agent <id>` — revokes all live tokens; sessions die at
  their next revalidate (§2.1).
- The raw durable **agentId is NOT a credential anymore** (D-N2-2 retired) —
  local agents get tokens auto-minted at boot and injected into their PTY
  env as `NVK_AGENT_TOKEN` (nvk-msg reads it); you never handle those.
- Issuing a token also runs the contact-policy sync (D-N6-5), so a fresh
  external's first message never 403s on the human's deny-by-default.
