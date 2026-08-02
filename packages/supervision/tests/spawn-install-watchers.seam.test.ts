import test from 'node:test';
import {
  assertInstallRunWatchersProviderContract,
  assertSpawnWatcherConsumerContract,
  type RunWatcherInstallerProviderHarness,
  type SpawnWatcherConsumerHarness,
} from '../contract/testkit/index.js';
import { installedWatchRules } from './fixtures.js';

const provider: RunWatcherInstallerProviderHarness = {
  installRunWatchers: async (_context, input) => ({
    ok: true,
    value: installedWatchRules(input),
  }),
};

test('Supervision provider installs every watcher required by the launch plan', async () => {
  await assertInstallRunWatchersProviderContract(provider);
});

test('spawn consumer blocks ready when Supervision partially omits watchers', async () => {
  const consumer: SpawnWatcherConsumerHarness = {
    completeWatcherStage: async (context, input, installer) => {
      const installed = await installer.installRunWatchers(context, input);
      if (!installed.ok) return { ready: false, installedRuleIds: [] };
      return {
        ready: installed.value.length === input.requiredTemplateRefs.length,
        installedRuleIds: installed.value.map((rule) => rule.id),
      };
    },
  };
  await assertSpawnWatcherConsumerContract(provider, consumer);
});
