import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_DRIFT_TEMPLATE_REF,
  type WatcherTemplateCatalogue,
} from '../contract/index.js';
import {
  IDLE_WATCH_TEMPLATE,
  createTemplateCatalogue,
} from '../core/templates.js';

test('explicit watcher refs resolve through the published minimal catalogue', () => {
  const catalogue: WatcherTemplateCatalogue = createTemplateCatalogue();
  assert.equal(catalogue.resolve(IDLE_WATCH_TEMPLATE.templateRef), IDLE_WATCH_TEMPLATE);
  assert.equal(catalogue.resolve({
    ...IDLE_WATCH_TEMPLATE.templateRef,
    digest: 'f'.repeat(64),
  }), null, 'a digest-mismatched explicit ref resolved');
  assert.notEqual(catalogue.resolve(ACTIVITY_DRIFT_TEMPLATE_REF), null,
    'the sole implicit template did not use the same catalogue path');
});
