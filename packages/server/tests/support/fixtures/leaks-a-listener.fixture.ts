// A fixture for `b3e-leak-guard.test.ts`, never collected by the suite glob
// (`tests/*.test.ts`).
//
// It is the P-01 shape in miniature: every assertion in the file PASSES, and
// the file still walks away from a listening socket. That is the case a
// green-looking suite hides — the worker cannot exit, and `node --test` waits
// on it forever.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

test('opens a listener and never closes it', async () => {
  const server = createServer((_request, response) => { response.end('ok'); });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const portFile = process.env['NVK_LEAK_FIXTURE_PORT_FILE'];
  if (portFile !== undefined) writeFileSync(portFile, String(port));
});
