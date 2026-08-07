import test from 'node:test';
import {
  assertInstallRunWatchersProviderContract,
  assertSpawnWatcherConsumerContract,
  fixtureTemplateRefForRule,
  type RunWatcherInstallerProviderHarness,
  type SpawnWatcherConsumerHarness,
} from '../../contract/testkit/index.js';
import { installedWatchRules } from '../fixtures.js';

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
      if (!installed.ok) {
        return { ready: false, installedRuleIds: [], installedTemplateRefs: [] };
      }
      const installedTemplateRefs = installed.value.flatMap((rule) => {
        const ref = fixtureTemplateRefForRule(rule);
        return ref === undefined ? [] : [ref];
      });
      const ready = installedTemplateRefs.length === input.requiredTemplateRefs.length
        && installedTemplateRefs.every((ref, index) => {
          const required = input.requiredTemplateRefs[index];
          return required !== undefined
            && ref.id === required.id
            && ref.version === required.version
            && ref.digest === required.digest;
        });
      return {
        ready,
        installedRuleIds: installed.value.map((rule) => rule.id),
        installedTemplateRefs,
      };
    },
  };
  await assertSpawnWatcherConsumerContract(provider, consumer);
});
