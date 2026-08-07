// S2b — nvk-context CLI (DEC-S2-6, §8): an agent in a raw terminal pulls the
// shell's current focus as {app, ref}. External PTY = pull only (§22 ruling 1).
import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const TSX = path.resolve('node_modules/.bin/tsx');
const CLI = path.resolve('cli/nvk-context.ts');

function withFocusServer(focus: unknown): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === 'getFocus') ws.send(JSON.stringify({ id: frame.id, result: focus }));
        else ws.send(JSON.stringify({ id: frame.id, error: `unknown method ${frame.method}` }));
      });
    });
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
  });
}

describe('nvk-context', () => {
  it('prints the shell host current focus as {app, ref}', async () => {
    const focus = { app: 'messaging', ref: { kind: 'conversation', id: 'conv_x' } };
    const server = await withFocusServer(focus);
    try {
      const { stdout } = await run(TSX, [CLI], { env: { ...process.env, NVK_SHELL_WS: server.url } });
      expect(JSON.parse(stdout.trim())).toEqual(focus);
    } finally { server.close(); }
  }, 30000);

  it('empty focus is a PRESENT context: {app, ref: "none"} (§22 ruling 7)', async () => {
    const server = await withFocusServer({ app: 'messaging', ref: 'none' });
    try {
      const { stdout } = await run(TSX, [CLI], { env: { ...process.env, NVK_SHELL_WS: server.url } });
      expect(JSON.parse(stdout.trim())).toEqual({ app: 'messaging', ref: 'none' });
    } finally { server.close(); }
  }, 30000);

  it('no shell host listening → typed HostUnreachable error, non-zero exit', async () => {
    await expect(run(TSX, [CLI], { env: { ...process.env, NVK_SHELL_WS: 'ws://127.0.0.1:1' } }))
      .rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('HostUnreachable'),
      });
  }, 30000);
});
