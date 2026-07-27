// S2a — Agents screen: kit-composed only (red gate 3 via tools/lint-kit.mjs),
// model picker writes through agents.setModel (DEC-S2-5 — shell stores no
// model truth), create/edit flows thread clientOpId (DEC-S2-12).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { saveModel, saveDefinition } from '../ui/screens/agents/agentsController.js';
import { AgentsView } from '../ui/screens/agents/AgentsScreen.js';
import { createMockServices } from '../demo/mockServices.js';
import type { AgentDefView } from '../contract/services.js';

describe('agents screen — kit only (red gate 3)', () => {
  it('lint-kit passes: the screen composes kit components, no raw DOM elements', () => {
    const out = execFileSync('node', ['tools/lint-kit.mjs'], { encoding: 'utf8' });
    expect(out).toContain('KIT GATE GREEN');
  });
});

describe('model picker (AGT-003, DEC-S2-5)', () => {
  it('calls agents.setModel with the def id, the model, and a minted clientOpId', async () => {
    const services = createMockServices();
    const calls: unknown[][] = [];
    const orig = services.agents!.setModel;
    services.agents!.setModel = (...a: unknown[]) => { calls.push(a); return orig(...(a as [string, string, string])); };
    const res = await saveModel(services, 'agent_kimi', 'kimi-k2-thinking');
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('agent_kimi');
    expect(calls[0][1]).toBe('kimi-k2-thinking');
    expect(String(calls[0][2])).toMatch(/^op_/);
  });

  it('rejects an empty model BEFORE touching the contract', async () => {
    const services = createMockServices();
    const calls: unknown[][] = [];
    const orig = services.agents!.setModel;
    services.agents!.setModel = (...a: unknown[]) => { calls.push(a); return orig(...(a as [string, string, string])); };
    const res = await saveModel(services, 'agent_kimi', '   ');
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe('agent definition create/edit', () => {
  it('create: defineAgent with displayName/provider/model/skills + clientOpId', async () => {
    const services = createMockServices();
    const res = await saveDefinition(services, null, {
      displayName: 'Scout', provider: 'claude', model: 'claude-sonnet-4',
      instructions: 'be terse', skills: ['skill_tdd'],
    });
    expect(res.ok).toBe(true);
    const all = await services.agents!.listAgents();
    const scout = all.find((a) => a.displayName === 'Scout');
    expect(scout?.provider).toBe('claude');
    expect(scout?.skills).toEqual(['skill_tdd']);
  });

  it('edit: updateAgent CAS with the current version; stale version surfaces the conflict', async () => {
    const services = createMockServices();
    const kimi = (await services.agents!.listAgents()).find((a) => a.id === 'agent_kimi')!;
    const res = await saveDefinition(services, kimi, {
      displayName: 'Kimi Prime', provider: 'kimi', model: kimi.model,
      instructions: 'new', skills: [],
    });
    expect(res.ok).toBe(true);
    // stale replay of the same edit at the old version → typed CasConflict
    const stale = await saveDefinition(services, kimi, {
      displayName: 'Kimi Again', provider: 'kimi', model: kimi.model, instructions: '', skills: [],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('CasConflict');
  });
});

describe('agents screen smoke render', () => {
  it('renders the def editor from kit components', () => {
    const agent: AgentDefView = {
      id: 'agent_kimi', displayName: 'Kimi', provider: 'kimi', model: 'kimi-k2',
      instructions: '', hooks: [{ id: 'hook_1', event: 'onSpawn', action: { kind: 'inject-context-text', text: 'hi' } }],
      skills: ['skill_tdd'], status: 'defined', version: 1,
    };
    const html = renderToStaticMarkup(React.createElement(AgentsView, {
      agent, skills: [{ id: 'skill_tdd', name: 'TDD', path: '.novakai/skills/tdd', description: '' }],
      error: null, onSave: () => undefined, onSaveModel: () => undefined,
    }));
    expect(html).toContain('Kimi');
    expect(html).toContain('kimi-k2');
    expect(html).toContain('onSpawn'); // hooks summary
    expect(html).toContain('TDD');     // skills multi-select from the registry
  });
});
