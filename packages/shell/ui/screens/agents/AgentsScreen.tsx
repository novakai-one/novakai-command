// shell/ui/screens/agents/AgentsScreen.tsx — S2a agent definition UI
// (AGT-003/004). Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs enforces).
// Shell keeps NO model truth (DEC-S2-5): the model picker writes via
// agents.setModel; every mutation mints a clientOpId at this layer (M5).
import React, { useCallback, useEffect, useState } from 'react';
import type { AgentDefView, ShellServices, SkillView } from '../../../contract/index.js';
import {
  Badge, Button, EmptyState, Field, InlineError, ListRow, Panel, ScrollArea, Select,
  Stack, TextInput,
} from '../../kit/index.js';
import { saveDefinition, saveModel, draftFromAgent, PROVIDER_OPTIONS, type AgentDraft } from './agentsController.js';
import { dedupeById } from '../../listDedupe.js';
import { answerFrom } from '../../../contract/listAnswer.js';
import './agents.css';

const EMPTY_DRAFT: AgentDraft = {
  displayName: '', provider: 'kimi', model: '', instructions: '', skills: [],
};

/** The def editor. Pure presentational — all state arrives as props. */
export function AgentsView(props: {
  agent: AgentDefView | null; // null = creating a new agent
  skills: SkillView[];
  error: string | null;
  onSave(draft: AgentDraft): void;
  onSaveModel(model: string): void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  useEffect(() => {
    // L15: stored provider shown verbatim — mock stays mock, never rewritten.
    setDraft(props.agent ? draftFromAgent(props.agent) : EMPTY_DRAFT);
  }, [props.agent]);

  const toggleSkill = (id: string) => {
    setDraft((d) => ({
      ...d,
      skills: d.skills.includes(id) ? d.skills.filter((s) => s !== id) : [...d.skills, id],
    }));
  };

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Panel head={props.agent ? `Agent — ${props.agent.displayName}` : 'New agent'}>
        <Stack className="nv-agents">
          {props.error && <InlineError>{props.error}</InlineError>}
          <Field label="Display name">
            <TextInput
              aria-label="Display name"
              value={draft.displayName}
              placeholder="Fable"
              onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
            />
          </Field>
          <Field label="Provider">
            <Select
              label="Provider"
              options={PROVIDER_OPTIONS}
              value={draft.provider}
              onChange={(v) => setDraft((d) => ({ ...d, provider: v as AgentDraft['provider'] }))}
            />
          </Field>
          <Field
            label="Model"
            hint="Model truth lives with the agents capability — this writes via setModel. The settings screen's lastUsedModel is a derived UI default only."
          >
            <Stack horizontal className="nv-agents__model">
              <TextInput
                aria-label="Model"
                value={draft.model}
                placeholder="kimi-k2"
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              />
              {props.agent && (
                <Button onClick={() => props.onSaveModel(draft.model)}>Save model</Button>
              )}
            </Stack>
          </Field>
          <Field label="Instructions" hint="Provider-neutral system-prompt text; the adapter injects it at spawn.">
            <TextInput
              aria-label="Instructions"
              value={draft.instructions}
              placeholder="Optional"
              onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
            />
          </Field>
          <Field label="Hooks" hint="Edited via the agents contract (attachHook/detachHook); summary shown here.">
            {props.agent && props.agent.hooks.length > 0 ? (
              <Stack horizontal className="nv-agents__hooks">
                {props.agent.hooks.map((h) => (
                  <Badge key={h.id}>{`${h.event} · ${h.action.kind}`}</Badge>
                ))}
              </Stack>
            ) : (
              <EmptyState>No hooks</EmptyState>
            )}
          </Field>
          <Field label="Skills" hint="From the provider-neutral skills registry.">
            {props.skills.length > 0 ? (
              <Stack gap={4} className="nv-agents__skills">
                {props.skills.map((s) => (
                  <ListRow
                    key={s.id}
                    label={s.name}
                    meta={s.path}
                    selected={draft.skills.includes(s.id)}
                    onClick={() => toggleSkill(s.id)}
                  />
                ))}
              </Stack>
            ) : (
              <EmptyState>No skills registered</EmptyState>
            )}
          </Field>
          <Stack horizontal className="nv-agents__actions">
            <Button primary onClick={() => props.onSave(draft)}>
              {props.agent ? 'Save definition' : 'Create agent'}
            </Button>
          </Stack>
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

export function AgentsScreen(props: { services: ShellServices }) {
  const { services } = props;
  // `null` until the roster answers. It used to start `[]`, which drew "No
  // agents defined yet" before anyone had been asked (contract/listAnswer.ts).
  const [agents, setAgents] = useState<AgentDefView[] | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!services.agents) return;
    setAgents(await services.agents.listAgents());
    setSkills(await services.agents.listSkills());
  }, [services]);
  useEffect(() => { void reload(); }, [reload]);

  if (!services.agents) {
    return <EmptyState>Agents service unavailable in this host.</EmptyState>;
  }

  const answer = answerFrom({
    source: agents,
    failure: null,
    rowsOf: (roster: AgentDefView[]) => dedupeById(roster), // G5: never paint the same agent twice
  });
  const roster = answer.kind === 'rows' ? answer.rows : [];
  const selected = roster.find((a) => a.id === selectedId) ?? null;

  const onSave = async (draft: AgentDraft) => {
    const res = await saveDefinition(services, creating ? null : selected, draft);
    if (res.ok) {
      setError(null);
      setCreating(false);
      setSelectedId(res.value.id);
      await reload();
    } else {
      setError(`${res.error.code}: ${res.error.message}`); // typed, drawn
    }
  };

  const onSaveModel = async (model: string) => {
    if (!selected) return;
    const res = await saveModel(services, selected.id, model);
    if (res.ok) { setError(null); await reload(); }
    else setError(`${res.error.code}: ${res.error.message}`);
  };

  return (
    <Stack horizontal gap={0} className="nv-agents-screen">
      <Stack gap={0} className="nv-agents-screen__list">
        <Panel head="Agents">
          <ScrollArea style={{ maxHeight: '100%' }}>
            {roster.map((a) => (
              <ListRow
                key={a.id}
                label={a.displayName}
                meta={`${a.provider} · ${a.model}`}
                selected={a.id === selectedId && !creating}
                onClick={() => { setCreating(false); setSelectedId(a.id); setError(null); }}
              />
            ))}
            {answer.kind === 'waiting' && <EmptyState>Reading agents…</EmptyState>}
            {answer.kind === 'none' && <EmptyState>No agents defined yet</EmptyState>}
          </ScrollArea>
          <Stack className="nv-agents-screen__new">
            <Button onClick={() => { setCreating(true); setSelectedId(null); setError(null); }}>
              New agent
            </Button>
          </Stack>
        </Panel>
      </Stack>
      <Stack gap={0} className="nv-agents-screen__editor">
        {selected || creating ? (
          <AgentsView
            agent={creating ? null : selected}
            skills={skills}
            error={error}
            onSave={onSave}
            onSaveModel={onSaveModel}
          />
        ) : (
          <EmptyState>Select an agent, or create a new one.</EmptyState>
        )}
      </Stack>
    </Stack>
  );
}
