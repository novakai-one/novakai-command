// shell/ui/screens/settings/SettingsScreen.tsx — SHL-009 + §11 rulings.
// Writes via setSetting ONLY; no model truth in shell (R3-22: model picker
// writes a last-used UI default labelled derivedFrom 'agents.setModel').
// Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs enforces; F2: the Motion
// control and every other picker use kit RadioGroup/Select/Swatch/Slider).
import React, { useState } from 'react';
import type { SettingsRecord, ShellServices } from '../../../contract/index.js';
import { settingValue, DEFAULT_RENDER_SPEED, mintShellOpId } from '../../../contract/index.js';
import { Button, Heading, InlineError, RadioGroup, ScrollArea, Select, Slider, Stack, Swatch, Text } from '../../kit/index.js';
import './settings.css';

const ACCENTS = ['#d0a14b', '#7ea6c9', '#9b8ac4', '#c98a7e'] as const;

/** One settings row: label (+ optional description) beside its control. */
function SettingRow(props: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <Stack horizontal className="nv-setting">
      <Stack className="nv-setting__label">
        <Text className="nv-setting__name">{props.name}</Text>
        {props.desc && <Text className="nv-setting__desc">{props.desc}</Text>}
      </Stack>
      {props.children}
    </Stack>
  );
}

export function SettingsScreen(props: {
  services: ShellServices;
  settings: SettingsRecord[];
  refresh(): Promise<void>;
  models: string[]; // provider-declared; the picker's candidates — truth stays in agents
}) {
  const { services, settings } = props;
  const [error, setError] = useState<string | null>(null);

  const theme = settingValue<'dark' | 'light'>(settings, 'theme') ?? 'dark';
  const accent = settingValue<string>(settings, 'accent') ?? '#d0a14b';
  const density = settingValue<'comfortable' | 'compact'>(settings, 'density') ?? 'comfortable';
  const motion = settingValue<'full' | 'reduced'>(settings, 'motion') ?? 'full';
  const bubbleStyle = settingValue<'bubbles' | 'minimal'>(settings, 'bubbleStyle') ?? 'bubbles';
  const speed = settingValue<number>(settings, 'renderSpeed.default') ?? DEFAULT_RENDER_SPEED;
  const model = settingValue<string>(settings, 'lastUsedModel') ?? props.models[0] ?? '';

  const apply = async (key: string, value: unknown, opts?: { derivedFrom?: string }) => {
    // M5/DEC-S2-12: clientOpId minted at the interaction layer, per mutation.
    const res = await services.setSetting(key, value, { ...opts, theme, clientOpId: mintShellOpId() });
    if (res.ok) { setError(null); await props.refresh(); }
    else setError(`${res.error.code}: ${res.error.message}`); // typed, drawn
  };

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Stack className="nv-settings">
        <Heading level={1}>Settings</Heading>
        {error && <InlineError>{error}</InlineError>}

        <Heading level={2}>Theme</Heading>
        <SettingRow name="Appearance" desc="Dark and light are both designed — pick what your room needs.">
          <RadioGroup
            className="nv-seg" label="Theme" value={theme}
            options={(['dark', 'light'] as const).map((t) => ({ value: t }))}
            onChange={(t) => void apply('theme', t)}
          />
        </SettingRow>

        <SettingRow name="Accent" desc="The one attention signal. Sub-contrast choices are rejected, not warned.">
          <Stack horizontal style={{ gap: 8 }}>
            {ACCENTS.map((a) => (
              <Swatch
                key={a} className="nv-swatch" color={a} selected={accent === a}
                label={`Accent ${a}`} onSelect={() => void apply('accent', a)}
              />
            ))}
          </Stack>
        </SettingRow>

        <Heading level={2}>Conversations</Heading>
        <SettingRow name="Thread speed" desc="How fast new text renders, in tokens per second. Your message, your speed.">
          <Slider
            min={10} max={2000} step={10} value={speed}
            aria-label="Thread render speed"
            onChange={(e) => void apply('renderSpeed.default', Number(e.target.value))}
          />
          <Text className="nv-setting__desc" style={{ minWidth: 64, textAlign: 'right' }}>{speed}/s</Text>
        </SettingRow>

        <SettingRow name="Bubble style">
          <RadioGroup
            className="nv-seg" label="Bubble style" value={bubbleStyle}
            options={(['bubbles', 'minimal'] as const).map((b) => ({ value: b }))}
            onChange={(b) => void apply('bubbleStyle', b)}
          />
        </SettingRow>

        <SettingRow name="Density">
          <RadioGroup
            className="nv-seg" label="Density" value={density}
            options={(['comfortable', 'compact'] as const).map((d) => ({ value: d }))}
            onChange={(d) => void apply('density', d)}
          />
        </SettingRow>

        <SettingRow name="Motion" desc="Reduced collapses every animation to instant — on top of your OS setting.">
          <RadioGroup
            className="nv-seg" label="Motion" value={motion}
            options={(['full', 'reduced'] as const).map((m) => ({ value: m }))}
            onChange={(m) => void apply('motion', m)}
          />
        </SettingRow>

        <Heading level={2}>Model</Heading>
        <SettingRow name="Last used model" desc="A UI default only — model truth lives with the agents capability.">
          <Select
            label="Model"
            options={props.models.map((m) => ({ value: m }))}
            value={model}
            onChange={(m) => void apply('lastUsedModel', m, { derivedFrom: 'agents.setModel' })}
          />
        </SettingRow>

        <Stack style={{ marginTop: 24 }}>
          <Button onClick={() => void props.refresh()}>Reload settings</Button>
        </Stack>
      </Stack>
    </ScrollArea>
  );
}
