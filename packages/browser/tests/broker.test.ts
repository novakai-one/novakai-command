// SessionBroker orchestration tests. Run with
// `npx tsx packages/browser/tests/broker.test.ts`.
// NEVER launches real Chrome — a FakeProvider stands in for ChromePool.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBroker, type BrowserProvider } from '../broker.js';
import type { BrowserInstance, LaunchSpec } from '../domain/types.js';

class FakeProvider implements BrowserProvider {
  launches = 0;
  disposed: number[] = [];
  lastSpec: LaunchSpec | null = null;
  private nextPort = 9300;
  async launch(spec: LaunchSpec): Promise<BrowserInstance> {
    this.launches += 1;
    this.lastSpec = spec;
    const port = this.nextPort += 1;
    return { processId: 1000 + port, port, userDataDir: `/tmp/udd-${port}`, cdpEndpoint: `http://127.0.0.1:${port}` };
  }
  async dispose(instance: BrowserInstance): Promise<void> {
    this.disposed.push(instance.processId);
  }
}

function registryDir(): string {
  return mkdtempSync(join(tmpdir(), 'mc-browser-'));
}

function fixedClock(isoText: string): () => Date {
  return () => new Date(isoText);
}

async function testGetOrCreateReuses(): Promise<void> {
  const provider = new FakeProvider();
  const broker = new SessionBroker({ provider, registryDir: registryDir(), clock: fixedClock('2026-07-17T00:00:00Z'), isAlive: () => true });
  const first = await broker.acquire('s1', 'a1');
  const second = await broker.acquire('s1', 'a1');
  assert.equal(provider.launches, 1, 'second acquire of same id reuses the instance');
  assert.equal(first.cdpEndpoint, second.cdpEndpoint, 'same endpoint returned');
}

async function testDistinctIdsAreIsolated(): Promise<void> {
  const provider = new FakeProvider();
  const broker = new SessionBroker({ provider, registryDir: registryDir(), isAlive: () => true });
  const alpha = await broker.acquire('alpha', 'a1');
  const bravo = await broker.acquire('bravo', 'a2');
  assert.equal(provider.launches, 2, 'each id gets its own instance');
  assert.notEqual(alpha.cdpEndpoint, bravo.cdpEndpoint, 'distinct endpoints');
}

async function testReconnectAcrossProcesses(): Promise<void> {
  const directory = registryDir();
  const first = new SessionBroker({ provider: new FakeProvider(), registryDir: directory, isAlive: () => true });
  await first.acquire('s1', 'a1');
  // A fresh broker over the same registry (a new CLI process) reuses.
  const secondProvider = new FakeProvider();
  const second = new SessionBroker({ provider: secondProvider, registryDir: directory, isAlive: () => true });
  await second.acquire('s1', 'a1');
  assert.equal(secondProvider.launches, 0, 'reconnecting broker reuses the persisted instance');
}

async function testExpiredLeaseRelaunches(): Promise<void> {
  const directory = registryDir();
  const provider = new FakeProvider();
  const first = new SessionBroker({ provider, registryDir: directory, clock: fixedClock('2026-07-17T00:00:00Z'), ttlMs: 1000, isAlive: () => true });
  await first.acquire('s1', 'a1');
  const second = new SessionBroker({ provider, registryDir: directory, clock: fixedClock('2026-07-17T00:00:10Z'), ttlMs: 1000, isAlive: () => true });
  await second.acquire('s1', 'a1');
  assert.equal(provider.launches, 2, 'expired lease forces a relaunch');
  assert.equal(provider.disposed.length, 1, 'old instance disposed');
}

async function testDeadInstanceRelaunches(): Promise<void> {
  const directory = registryDir();
  const provider = new FakeProvider();
  const first = new SessionBroker({ provider, registryDir: directory, isAlive: () => true });
  await first.acquire('s1', 'a1');
  const second = new SessionBroker({ provider, registryDir: directory, isAlive: () => false });
  await second.acquire('s1', 'a1');
  assert.equal(provider.launches, 2, 'dead instance forces a relaunch');
  assert.equal(provider.disposed.length, 1, 'dead instance disposed');
}

async function testReleaseDisposesAndDrops(): Promise<void> {
  const provider = new FakeProvider();
  const broker = new SessionBroker({ provider, registryDir: registryDir(), isAlive: () => true });
  await broker.acquire('s1', 'a1');
  await broker.release('s1');
  assert.equal(provider.disposed.length, 1, 'release disposes the instance');
  assert.equal(broker.list().length, 0, 'released session no longer listed');
}

async function testLaunchSpecFlowsToProvider(): Promise<void> {
  const provider = new FakeProvider();
  const broker = new SessionBroker({ provider, registryDir: registryDir(), isAlive: () => true });
  await broker.acquire('shared', 'a1', { headless: false });
  assert.equal(provider.lastSpec?.headless, false, 'the launch spec reaches the provider (--shared => windowed)');
}

await testGetOrCreateReuses();
await testDistinctIdsAreIsolated();
await testReconnectAcrossProcesses();
await testExpiredLeaseRelaunches();
await testDeadInstanceRelaunches();
await testReleaseDisposesAndDrops();
await testLaunchSpecFlowsToProvider();
console.log('PASS');
