// shell/ui/screens/settings/SettingsScreen.tsx — SHL-009 + §11 rulings.
// Writes via setSetting ONLY; no model truth in shell (R3-22: model picker
// writes a last-used UI default labelled derivedFrom 'agents.setModel').
import React, { useState } from 'react';
import type { SettingsRecord, ShellServices } from '../../../contract/index.js';
import { settingValue, DEFAULT_RENDER_SPEED, mintShellOpId } from '../../../contract/index.js';
import { Button, ScrollArea } from '../../kit/index.js';
import './settings.css';

const ACCENTS = ['#d0a14b', '#7ea6c9', '#9b8ac4', '#c98a7e'] as const;

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
      <div className="nv-settings">
        <h1>Settings</h1>
        {error && <div className="nv-setting__error" role="alert">{error}</div>}

        <h2>Theme</h2>
        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Appearance</div>
            <div className="nv-setting__desc">Dark and light are both designed — pick what your room needs.</div>
          </div>
          <div className="nv-seg" role="radiogroup" aria-label="Theme">
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={theme === t} data-on={theme === t ? 'true' : 'false'}
                onClick={() => void apply('theme', t)}>{t}</button>
            ))}
          </div>
        </div>

        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Accent</div>
            <div className="nv-setting__desc">The one attention signal. Sub-contrast choices are rejected, not warned.</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ACCENTS.map((a) => (
              <button key={a} className="nv-swatch" style={{ background: a }}
                aria-label={`Accent ${a}`} aria-pressed={accent === a}
                data-on={accent === a ? 'true' : 'false'}
                onClick={() => void apply('accent', a)} />
            ))}
          </div>
        </div>

        <h2>Conversations</h2>
        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Thread speed</div>
            <div className="nv-setting__desc">How fast new text renders, in tokens per second. Your message, your speed.</div>
          </div>
          <input
            type="range" min={10} max={2000} step={10} value={speed}
            aria-label="Thread render speed"
            onChange={(e) => void apply('renderSpeed.default', Number(e.target.value))}
          />
          <span className="nv-setting__desc" style={{ minWidth: 64, textAlign: 'right' }}>{speed}/s</span>
        </div>

        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Bubble style</div>
          </div>
          <div className="nv-seg" role="radiogroup" aria-label="Bubble style">
            {(['bubbles', 'minimal'] as const).map((b) => (
              <button key={b} role="radio" aria-checked={bubbleStyle === b} data-on={bubbleStyle === b ? 'true' : 'false'}
                onClick={() => void apply('bubbleStyle', b)}>{b}</button>
            ))}
          </div>
        </div>

        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Density</div>
          </div>
          <div className="nv-seg" role="radiogroup" aria-label="Density">
            {(['comfortable', 'compact'] as const).map((d) => (
              <button key={d} role="radio" aria-checked={density === d} data-on={density === d ? 'true' : 'false'}
                onClick={() => void apply('density', d)}>{d}</button>
            ))}
          </div>
        </div>

        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Motion</div>
            <div className="nv-setting__desc">Reduced collapses every animation to instant — on top of your OS setting.</div>
          </div>
          <div className="nv-seg" role="radiogroup" aria-label="Motion">
            {(['full', 'reduced'] as const).map((m) => (
              <button key={m} role="radio" aria-checked={motion === m} data-on={motion === m ? 'true' : 'false'}
                onClick={() => void apply('motion', m)}>{m}</button>
            ))}
          </div>
        </div>

        <h2>Model</h2>
        <div className="nv-setting">
          <div className="nv-setting__label">
            <div className="nv-setting__name">Last used model</div>
            <div className="nv-setting__desc">A UI default only — model truth lives with the agents capability.</div>
          </div>
          <select
            className="k-input" style={{ width: 180 }}
            value={model}
            aria-label="Model"
            onChange={(e) => void apply('lastUsedModel', e.target.value, { derivedFrom: 'agents.setModel' })}
          >
            {props.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div style={{ marginTop: 24 }}>
          <Button onClick={() => void props.refresh()}>Reload settings</Button>
        </div>
      </div>
    </ScrollArea>
  );
}
