#!/usr/bin/env node
// nvk-context — the agent-facing context query (DEC-S2-6, §8 "shell adapter").
// An agent in a RAW terminal pulls the shell's current focus; external PTY
// sessions are pull-only (§22 ruling 1 — no push exists outside the live lane).
//
// Transport: the shell host's JSON-RPC socket (demo bridge today, Electron
// host later). NVK_SHELL_WS overrides the default ws://127.0.0.1:4173.
// Output: the current focus as JSON {app, ref} — {app, ref:"none"} is a
// PRESENT context (§22 ruling 7), printed as-is.

const url = process.env.NVK_SHELL_WS ?? 'ws://127.0.0.1:4173';

const die = (e: { code: string; message: string; retryable: boolean }): never => {
  process.stderr.write(`${JSON.stringify(e)}\n`);
  process.exit(1);
};

async function main(): Promise<void> {
  if (typeof WebSocket !== 'function') {
    die({ code: 'UnsupportedRuntime', message: 'nvk-context needs Node >= 22 (global WebSocket)', retryable: false });
  }
  const focus = await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout'));
    }, 3000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'getFocus', params: {} }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connect failed')); };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const frame = JSON.parse(String(ev.data));
        if (frame.error) reject(new Error(String(frame.error)));
        else resolve(frame.result);
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      ws.close();
    };
  }).catch((cause: Error) =>
    die({
      code: 'HostUnreachable',
      message: `no shell host at ${url} (${cause.message}) — focus is pull-only for external sessions`,
      retryable: true,
    }));
  process.stdout.write(`${JSON.stringify(focus, null, 2)}\n`);
}

void main();
