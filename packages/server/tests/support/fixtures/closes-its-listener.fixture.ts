// The control for `b3e-leak-guard.test.ts`: the same work, cleaned up the way
// the guard's message asks for it — the close registered AT THE BOOT, so a
// later failure in the same test cannot skip it.
//
// The guard must not bite this file. A leak guard that fails honest files is
// worse than no guard: it teaches the lane to ignore the failure.
import { test } from 'node:test';
import { createServer } from 'node:http';

test('opens a listener and registers its close at the boot', async (context) => {
  const server = createServer((_request, response) => { response.end('ok'); });
  context.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
});
