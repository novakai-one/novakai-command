import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  TranscriptContract,
} from '../../transcript/contract/index.js';
import { buildTranscriptMethods } from '../core/b2b/methods.js';

const EXACT_METHODS = [
  'linesByProvider',
  'linesBySession',
  'subagentTree',
];

function harness(): {
  operations: TranscriptContract;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { ok: true as const, value: [] };
  };
  return {
    calls,
    operations: {
      ingest: async () => ({
        ok: true,
        value: {
          added: 0,
          duplicates: 0,
          skipped: [],
          diagnostics: [],
        },
      }),
      linesBySession: query('linesBySession'),
      linesByProvider: query('linesByProvider'),
      subagentTree: query('subagentTree'),
    } as TranscriptContract,
  };
}

test('Transcript WS adapter exposes exactly the three read-only contract queries', async () => {
  const h = harness();
  const methods = buildTranscriptMethods(h.operations);
  assert.deepEqual(Object.keys(methods).sort(), EXACT_METHODS);
  assert.equal('ingest' in methods, false);
  assert.equal('search' in methods, false);

  for (const [method, params] of [
    ['linesBySession', { sessionRef: 'providerSession_ws' }],
    ['linesByProvider', {
      provider: 'claude',
      since: '2026-07-29T00:00:00.000Z',
    }],
    ['subagentTree', { turnId: 'claude:turn_parent' }],
  ] as const) {
    const result = await methods[method]!(params as never) as {
      ok: boolean;
    };
    assert.equal(result.ok, true, method);
  }
  assert.deepEqual(h.calls, [
    {
      method: 'linesBySession',
      args: ['providerSession_ws'],
    },
    {
      method: 'linesByProvider',
      args: ['claude', '2026-07-29T00:00:00.000Z'],
    },
    {
      method: 'subagentTree',
      args: ['claude:turn_parent'],
    },
  ]);
});

test('Transcript WS adapter rejects malformed query input before delegation', async () => {
  const h = harness();
  const methods = buildTranscriptMethods(h.operations);
  for (const [method, params] of [
    ['linesBySession', { sessionRef: '' }],
    ['linesByProvider', { provider: 'mock' }],
    ['linesByProvider', { provider: 'kimi', since: 'yesterday' }],
    ['subagentTree', { turnId: '' }],
  ] as const) {
    const result = await methods[method]!(params as never) as {
      ok: boolean;
      error?: {
        code?: string;
        message?: string;
        retryable?: boolean;
      };
    };
    assert.equal(result.ok, false, method);
    assert.equal(result.error?.code, 'InvalidEnvelope', method);
    assert.equal(result.error?.message, `${method} input is invalid`, method);
    assert.equal(result.error?.retryable, false, method);
  }
  assert.deepEqual(h.calls, []);
});
