// S2b — inspector (DEC-S2-8, §22 ruling 10): click → peek → expand →
// breadcrumb back. Kinds without a registered screen render the GENERIC
// inspector (envelope + payload view); invokeAction with an unknown actionId
// or absent owner is a typed error. "Inspect and act": one primary action.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import {
  invokeAction, registerActionHandler, __resetActionHandlers,
} from '../contract/index.js';
import {
  registerInspectorScreen, inspectorScreenFor, __resetInspectorRegistry,
} from '../ui/inspector/registry.js';
import { Inspector } from '../ui/inspector/Inspector.js';
import { GenericInspector } from '../ui/inspector/GenericInspector.js';
import { MessageInspector } from '../ui/inspector/MessageInspector.js';
import type { ChatMessage } from '../contract/index.js';

const message: ChatMessage = {
  id: 'msg_1', conversationId: 'conv_kimi', senderId: 'person_kimi',
  text: 'hello from the agent', createdAt: new Date().toISOString(),
};

beforeEach(() => {
  __resetActionHandlers();
  __resetInspectorRegistry();
});

describe('inspector registry (ruling 10)', () => {
  it('a kind WITHOUT a registered screen falls back to the generic inspector', () => {
    expect(inspectorScreenFor('design')).toBeNull();
    const html = renderToStaticMarkup(
      React.createElement(Inspector, {
        kind: 'design', envelope: { id: 'design_1', kind: 'design', createdBy: 'person_chris' },
        payload: { width: 120, title: 'Hero' },
      }),
    );
    expect(html).toContain('design_1');
    expect(html).toContain('person_chris'); // envelope view
    expect(html).toContain('Hero');        // payload view
  });

  it('a registered kind renders ITS screen, not the generic one', () => {
    registerInspectorScreen('message', MessageInspector);
    expect(inspectorScreenFor('message')).toBe(MessageInspector);
    const html = renderToStaticMarkup(
      React.createElement(Inspector, { kind: 'message', payload: message }),
    );
    expect(html).toContain('hello from the agent');
    expect(html).toContain('person_kimi');
  });
});

describe('generic inspector (envelope + payload)', () => {
  it('renders envelope fields and the payload as inspectable data', () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericInspector, {
        envelope: { id: 'x_1', kind: 'mystery', createdAt: '2026-07-28T00:00:00Z' },
        payload: { a: 1 },
      }),
    );
    expect(html).toContain('mystery');
    expect(html).toContain('x_1');
    expect(html).toContain('&quot;a&quot;: 1');
  });
});

describe('message inspector screen', () => {
  it('shows sender, text, and declares reply as its primary action', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageInspector, { payload: message, onAction: () => undefined }),
    );
    expect(html).toContain('person_kimi');
    expect(html).toContain('hello from the agent');
    expect(html).toContain('Reply');
  });
});

describe('invokeAction (typed errors, ruling 10)', () => {
  it('unknown actionId on a known kind → typed ActionNotFound', async () => {
    registerActionHandler('message', 'reply', async () => 'done');
    const res = await invokeAction({ kind: 'message', id: 'msg_1' }, 'delete');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ActionNotFound');
  });

  it('absent owner (no handler for the kind at all) → typed ActionNotFound', async () => {
    const res = await invokeAction({ kind: 'ghost', id: 'g_1' }, 'reply');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ActionNotFound');
  });

  it('inspect and act: the reply action reaches the owning capability handler', async () => {
    const calls: Array<{ ref: unknown; actionId: string }> = [];
    registerActionHandler('message', 'reply', async (ref, actionId) => {
      calls.push({ ref, actionId });
      return { focused: true };
    });
    const res = await invokeAction({ kind: 'message', id: 'msg_1' }, 'reply');
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ ref: { kind: 'message', id: 'msg_1' }, actionId: 'reply' }]);
  });
});
