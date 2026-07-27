// shell/ui/App.tsx — the composition: frame + nav state + theme application.
// SHL-010: at most one attention signal per viewport — enforced by
// tools/lint-accent.mjs. Liveness dots use --sage, never the accent token.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsRecord, ShellServices } from '../contract/index.js';
import {
  PresenceTracker, SlashRegistry, publishFocus, getFocus, settingValue,
} from '../contract/index.js';
import { Frame, type BreadcrumbItem } from './frame/Frame.js';
import { MessagingScreen, MessagingRail } from './screens/messaging/MessagingScreen.js';
import { SettingsScreen } from './screens/settings/SettingsScreen.js';
import { AgentsScreen } from './screens/agents/AgentsScreen.js';
import { Inspector } from './inspector/Inspector.js';
import { ListRow } from './kit/index.js';

export function App(props: { services: ShellServices; models?: string[] }) {
  const { services } = props;
  const [settings, setSettings] = useState<SettingsRecord[]>([]);
  const [view, setView] = useState<'messaging' | 'agents' | 'settings'>('messaging');
  const [selectedConvo, setSelectedConvo] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const [expanded, setExpanded] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([]);
  const [composerHeight, setComposerHeight] = useState(132);

  const tracker = useMemo(() => new PresenceTracker(), []);
  const registry = useMemo(() => new SlashRegistry(), []);

  useEffect(() => { tracker.attach(services.presence); return () => tracker.detach(); }, [tracker, services]);

  const refreshSettings = useCallback(async () => {
    setSettings(await services.getSettings());
  }, [services]);
  useEffect(() => { void refreshSettings(); }, [refreshSettings]);

  // theme/density/accent application — CSS variables only, one source of truth
  const theme = settingValue<'dark' | 'light'>(settings, 'theme') ?? 'dark';
  const density = settingValue<'comfortable' | 'compact'>(settings, 'density') ?? 'comfortable';
  const motion = settingValue<'full' | 'reduced'>(settings, 'motion') ?? 'full';
  const accent = settingValue<string>(settings, 'accent');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.motion = motion;
    if (accent) document.documentElement.style.setProperty('--accent', accent);
  }, [theme, density, motion, accent]);

  const onSelectConvo = useCallback((id: string | null) => {
    setSelectedConvo(id);
    publishFocus(id ? { kind: 'conversation', id } : 'none');
    services.publishFocus?.(getFocus()); // forward to the host focus authority (SHL-008)
  }, [services]);

  // DEC-S2-8: click → peek in inspector → expand into the workspace with a
  // breadcrumb → back. Any breadcrumb navigation returns to the base view.
  const onBreadcrumb = useCallback((id: string | null) => {
    if (id === '__expand__') {
      if (inspected) {
        setBreadcrumb((b) => [...b, { id: String(b.length), label: inspected.title }]);
        setExpanded(inspected);
        setInspected(null);
      }
      return;
    }
    setBreadcrumb([]);
    setExpanded(null);
  }, [inspected]);

  const rail = view === 'messaging' ? (
    <MessagingRail services={services} tracker={tracker} selectedId={selectedConvo}
      onSelect={(id) => onSelectConvo(id)} />
  ) : null;

  const railTop = (
    <div className="nv-rail__wide" style={{ padding: '2px 6px' }}>
      <ListRow label="Messages" selected={view === 'messaging'} onClick={() => setView('messaging')} />
      <ListRow label="Agents" selected={view === 'agents'} onClick={() => setView('agents')} />
      <ListRow label="Settings" selected={view === 'settings'} onClick={() => setView('settings')} />
    </div>
  );

  return (
    <Frame
      services={services}
      railTop={railTop}
      rail={rail}
      breadcrumb={breadcrumb}
      onBreadcrumb={onBreadcrumb}
      inspector={inspected}
      workspace={expanded ? (
        <div className="nv-expanded">{expanded.body}</div>
      ) : view === 'messaging' ? (
        <MessagingScreen
          services={services}
          composerHeight={composerHeight}
          onComposerResize={(d) => setComposerHeight((h) => Math.min(320, Math.max(96, h + d)))}
          selectedId={selectedConvo}
          onSelect={onSelectConvo}
          onInspectConversation={(c) => setInspected({
            title: c.title,
            body: <Inspector kind="conversation" refId={c.id}
              envelope={{ kind: 'conversation', id: c.id, title: c.title, conversationKind: c.kind }}
              payload={c} />,
          })}
          onInspectMessage={(m) => setInspected({
            title: `Message · ${m.senderId}`,
            body: <Inspector kind="message" refId={m.id}
              envelope={{ kind: 'message', id: m.id }}
              payload={m} />,
          })}
          onOpenSettings={() => setView('settings')}
          registry={registry}
          tracker={tracker}
          settings={settings}
          refreshSettings={refreshSettings}
        />
      ) : view === 'agents' ? (
        <AgentsScreen services={services} />
      ) : (
        <SettingsScreen services={services} settings={settings} refresh={refreshSettings}
          models={props.models ?? ['kimi-k2', 'claude-sonnet-4', 'codex-1']} />
      )}
    />
  );
}
