// S2b — context bus (req 9, SHL-008, DEC-S2-6/7, §22 rulings 1+7).
// Send-time snapshot attached to EVERY human-composed message (red gate 2:
// missing context = violation; {app, ref:'none'} counts as present).
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import {
  publishFocus, getFocus, subscribeFocus,
  requireContext, attachContext, composeHumanMessage,
  type ScreenContext,
} from '../contract/index.js';
import { FocusChip } from '../ui/screens/messaging/FocusChip.js';
import { createMockServices } from '../app/mockServices.js';

beforeEach(() => {
  publishFocus('none'); // reset module state between tests
});

describe('focus model (DEC-S2-7)', () => {
  it('defaults to {app, ref: none} — present, never missing', () => {
    const f = getFocus();
    expect(f.ref).toBe('none');
    expect(typeof f.app).toBe('string');
  });

  it('publishFocus updates the snapshot and notifies subscribers', () => {
    const seen: ScreenContext[] = [];
    const unsub = subscribeFocus((f) => seen.push(f));
    publishFocus({ kind: 'conversation', id: 'conv_kimi' });
    unsub();
    expect(getFocus()).toEqual({ app: 'messaging', ref: { kind: 'conversation', id: 'conv_kimi' } });
    expect(seen).toEqual([{ app: 'messaging', ref: { kind: 'conversation', id: 'conv_kimi' } }]);
  });
});

describe('send-time snapshot (red gate 2)', () => {
  it('requireContext: {app, ref: none} counts as PRESENT (§22 ruling 7)', () => {
    const res = requireContext({ app: 'messaging', ref: 'none' });
    expect(res.ok).toBe(true);
  });

  it('requireContext: missing context is a typed violation, never silent', () => {
    const res = requireContext(undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('MissingContext');
  });

  it('attachContext stamps the snapshot onto the outbound payload', () => {
    const ctx: ScreenContext = { app: 'messaging', ref: { kind: 'conversation', id: 'conv_x' } };
    const payload = attachContext({ text: 'fix this' }, ctx);
    expect(payload.context).toEqual(ctx);
  });

  it('composeHumanMessage: every human-composed message carries context', () => {
    publishFocus({ kind: 'conversation', id: 'conv_kimi' });
    const m = composeHumanMessage({ conversationId: 'conv_kimi', text: 'hello' });
    expect(m.context).toEqual({ app: 'messaging', ref: { kind: 'conversation', id: 'conv_kimi' } });
    expect(m.senderId).toBe('me');
  });

  it('composeHumanMessage: the snapshot is taken at SEND time, not compose time', () => {
    publishFocus({ kind: 'conversation', id: 'conv_a' });
    publishFocus({ kind: 'conversation', id: 'conv_b' }); // focus moved before send
    const m = composeHumanMessage({ conversationId: 'conv_b', text: 'fix this' });
    expect(m.context?.ref).toEqual({ kind: 'conversation', id: 'conv_b' });
  });
});

describe('services seam (payload inspection end-to-end)', () => {
  it('mock services: a sent message carries the published focus snapshot', async () => {
    const services = createMockServices();
    services.publishFocus!({ app: 'messaging', ref: { kind: 'conversation', id: 'conv_kimi' } });
    const res = await services.sendMessage('conv_kimi', 'hello', 'op_context_snapshot');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.context).toEqual({ app: 'messaging', ref: { kind: 'conversation', id: 'conv_kimi' } });
    }
  });

  it('mock services: default focus (nothing focused) still satisfies the gate', async () => {
    const services = createMockServices();
    const res = await services.sendMessage('conv_kimi', 'hello', 'op_context_default');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.context).toEqual({ app: 'messaging', ref: 'none' });
  });
});

describe('composer context chip (demo affordance)', () => {
  it('renders the focused object', () => {
    const html = renderToStaticMarkup(
      React.createElement(FocusChip, { focus: { app: 'messaging', ref: { kind: 'conversation', id: 'conv_x' } } }),
    );
    expect(html).toContain('conv_x');
    expect(html).toContain('👁');
  });

  it('renders "nothing focused" for ref none', () => {
    const html = renderToStaticMarkup(
      React.createElement(FocusChip, { focus: { app: 'messaging', ref: 'none' } }),
    );
    expect(html).toContain('nothing focused');
  });
});
