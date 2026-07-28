// shell/ui/screens/messaging/Composer.tsx — SHL-005.
// Slash palette on '/', dispatch order built-ins → provider-declared → typed
// UnknownCommand error drawn inline (never silent, never blank).
import React, { useMemo, useState } from 'react';
import type { DispatchResult, SlashCommand, SlashRegistry } from '../../../contract/index.js';
import { ComposerInput, MenuRow, Stack, Text } from '../../kit/index.js';

export function Composer(props: {
  registry: SlashRegistry;
  height: number;
  onResize(deltaPx: number): void;
  onSend(text: string): void;
  onBuiltin(name: string, args: string): void;
  onProvider(name: string, args: string): void;
}) {
  const [value, setValue] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const partial = paletteOpen && value.startsWith('/') && !value.includes(' ')
    ? value.slice(1) : '';
  const suggestions: SlashCommand[] = useMemo(
    () => (paletteOpen ? props.registry.suggest(partial) : []),
    [paletteOpen, partial, props.registry],
  );

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const result: DispatchResult = props.registry.dispatch(text);
    setValue('');
    setPaletteOpen(false);
    switch (result.kind) {
      case 'message':
        setInlineError(null);
        props.onSend(result.text);
        break;
      case 'builtin':
        setInlineError(null);
        props.onBuiltin(result.name, result.args);
        break;
      case 'provider':
        setInlineError(null);
        props.onProvider(result.name, result.args);
        break;
      case 'error':
        // typed error, drawn — never silent (SHL-005)
        setInlineError(`${result.error.message}${result.error.details.suggestions.length ? ` — try ${result.error.details.suggestions.join(', ')}` : ''}`);
        break;
    }
  };

  return (
    <Stack className="composer-wrap">
      {paletteOpen && suggestions.length > 0 && (
        <Stack className="nv-palette" role="listbox" aria-label="Slash commands">
          {suggestions.map((c, i) => (
            <MenuRow
              key={`${c.source}:${c.name}`}
              className="nv-palette__row"
              label={<Text className="nv-palette__cmd">/{c.name}</Text>}
              meta={<Text className="nv-palette__desc">{c.description}</Text>}
              trailing={<Text className="nv-palette__src">{c.source === 'shell' ? 'shell' : 'provider'}</Text>}
              selected={i === sel}
              onHover={() => setSel(i)}
              onPick={() => { setValue(`/${c.name} `); setPaletteOpen(false); }}
            />
          ))}
        </Stack>
      )}
      <ComposerInput
        value={value}
        height={props.height}
        onResize={props.onResize}
        onSubmit={submit}
        hint={inlineError
          ? <Text style={{ color: 'var(--danger)' }}>{inlineError}</Text>
          : undefined}
        onChange={(v) => {
          setValue(v);
          setInlineError(null);
          if (v === '/') { setPaletteOpen(true); setSel(0); }
          else if (paletteOpen && (v.length === 0 || !v.startsWith('/') || v.includes(' '))) setPaletteOpen(false);
          else if (v.startsWith('/') && !paletteOpen && !v.includes(' ')) setPaletteOpen(true);
        }}
      />
      <PaletteKeys active={paletteOpen} count={suggestions.length} sel={sel} setSel={setSel}
        onPick={() => { const c = suggestions[sel]; if (c) { setValue(`/${c.name} `); setPaletteOpen(false); } }}
        onClose={() => setPaletteOpen(false)} />
    </Stack>
  );
}

// Keyboard nav for the palette, attached at window level while open.
function PaletteKeys(props: { active: boolean; count: number; sel: number; setSel(n: number): void; onPick(): void; onClose(): void }) {
  React.useEffect(() => {
    if (!props.active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); props.setSel(Math.min(props.count - 1, props.sel + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); props.setSel(Math.max(0, props.sel - 1)); }
      if (e.key === 'Tab' || (e.key === 'Enter' && props.count > 0)) { e.preventDefault(); e.stopPropagation(); props.onPick(); }
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [props]);
  return null;
}
