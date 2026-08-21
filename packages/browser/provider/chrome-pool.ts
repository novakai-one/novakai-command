// ChromePool — the impure BrowserProvider. Each launch is a fully isolated,
// headless Chrome process: its own debug port (OS-assigned, never 9222) and its
// own user-data-dir, with no window at all, so it can neither collide with
// another instance nor steal the user's foreground.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProvider } from '../broker.js';
import type { BrowserInstance, LaunchSpec } from '../domain/types.js';

const READY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const DISPOSE_SETTLE_MS = 200;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => reject(new Error('could not determine a free port')));
      }
    });
  });
}

function resolveChromePath(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  throw new Error('Chrome not found. Set CHROME_PATH to the Chrome binary.');
}

function chromeArgs(port: number, userDataDir: string, headless: boolean): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  // Headless windows default to ~800x600, which collapses responsive layouts;
  // UI verification needs a real desktop viewport.
  if (headless) args.unshift('--headless=new', `--window-size=${process.env.NVK_BROWSER_SIZE ?? '1560,960'}`);
  return args;
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // endpoint not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Chrome CDP endpoint on port ${port} did not become ready`);
}

export class ChromePool implements BrowserProvider {
  async launch(spec: LaunchSpec): Promise<BrowserInstance> {
    const port = await freePort();
    const userDataDir = mkdtempSync(join(tmpdir(), 'nvk-chrome-'));
    const child = spawn(resolveChromePath(), chromeArgs(port, userDataDir, spec.headless), { detached: true, stdio: 'ignore' });
    child.unref();
    const processId = child.pid;
    if (processId === undefined) throw new Error('failed to spawn Chrome');
    try {
      await waitForCdp(port);
    } catch (caught) {
      await this.dispose({ processId, port, userDataDir, cdpEndpoint: '' });
      throw caught;
    }
    return { processId, port, userDataDir, cdpEndpoint: `http://127.0.0.1:${port}` };
  }

  async dispose(instance: BrowserInstance): Promise<void> {
    try {
      process.kill(instance.processId);
    } catch {
      // already gone
    }
    // Let Chrome release its profile files before removing — killing and rm-ing
    // in the same tick races (ENOTEMPTY).
    await new Promise((resolve) => setTimeout(resolve, DISPOSE_SETTLE_MS));
    rmSync(instance.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
