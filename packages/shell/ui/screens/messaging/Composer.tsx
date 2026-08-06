// shell/ui/screens/messaging/Composer.tsx — SHL-005 / FZ-VIEW-032.
//
// The composer PARSES NOTHING. It hands the typed line and the situation to
// `readSlashInput` and executes the answer. Every branch of that answer is drawn
// — including the two refusals, which is the fix for the defect this screen
// shipped with: `/model opus` used to clear the box and do nothing at all, so
// the only thing left on screen said "sent".
import React, { useMemo, useState } from 'react';
import type { SlashAnswer, SlashCommand, SlashRegistry, SlashSituation } from '../../../contract/index.js';
import { palettePartial, readSlashInput, slashPalette, SHELL_SLASH_DOORS } from '../../../contract/index.js';
import { ComposerInput, MenuRow, Stack, Text } from '../../kit/index.js';

export function Composer(props: {
  registry: SlashRegistry;
  height: number;
  onResize(deltaPx: number): void;
  onSend(text: string): void;
  onBuiltin(name: string, args: string): void;
  /**
   * Supplied ONLY by a host that has a control door. Optional because the door
   * and the handler must agree: a host with no route supplies neither, and the
   * refusal comes from `readSlashInput`. If a host ever wires one without the
   * other, the branch below refuses out loud rather than dropping the control.
   */
  onControl?(name: string, value: string): void;
}) {
  const [value, setValue] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [refusal, setRefusal] = useState<{ because: string; instead: string | null } | null>(null);

  // The composer IS the Calm/Message surface (FZ-VIEW-032: Raw is the terminal
  // tab, and Raw input never reaches this component).
  const situation: SlashSituation = useMemo(() => ({
    surface: 'calm',
    holdsInputLease: false,
    providerDeclared: props.registry.declaredNames(),
    doors: SHELL_SLASH_DOORS,
  }), [props.registry]);

  const partial = paletteOpen ? palettePartial(value) : null;
  const suggestions: readonly SlashCommand[] = useMemo(
    () => (partial === null ? [] : slashPalette(partial, situation, props.registry.declared())),
    [partial, situation, props.registry],
  );

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const answer: SlashAnswer = readSlashInput(text, situation);
    setValue('');
    setPaletteOpen(false);
    setRefusal(null);
    switch (answer.kind) {
      case 'message':
        props.onSend(answer.text);
        break;
      case 'novakai':
        props.onBuiltin(answer.name, answer.args);
        break;
      case 'provider-control':
        // Routed through the NAMED control contract — never stdin injection.
        if (props.onControl) props.onControl(answer.control.name, answer.control.value);
        else setRefusal({
          because: `This host reports a route for /${answer.control.name} but wired no handler for it, `
            + 'so nothing was sent.',
          instead: `nvk agent control <agentRunId> --name ${answer.control.name} --value ${answer.control.value}`,
        });
        break;
      case 'refused':
        setRefusal({ because: answer.because, instead: answer.instead });
        break;
      case 'unknown':
        setRefusal({
          because: answer.error.message,
          instead: answer.error.details.suggestions.length
            ? `Try ${answer.error.details.suggestions.join(', ')}`
            : null,
        });
        break;
      // `raw-passthrough` / `raw-blocked` cannot occur on this surface, and a
      // `default` that swallowed them would be the silent branch all over again.
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
        hint={refusal ? <SlashRefusal because={refusal.because} instead={refusal.instead} /> : undefined}
        onChange={(v) => {
          setValue(v);
          setRefusal(null);
          if (palettePartial(v) === null) setPaletteOpen(false);
          else { if (!paletteOpen) setSel(0); setPaletteOpen(true); }
        }}
      />
      <PaletteKeys active={paletteOpen} count={suggestions.length} sel={sel} setSel={setSel}
        onPick={() => { const c = suggestions[sel]; if (c) { setValue(`/${c.name} `); setPaletteOpen(false); } }}
        onClose={() => setPaletteOpen(false)} />
    </Stack>
  );
}

/**
 * A refusal is two sentences doing different jobs: what did NOT happen, and what
 * to do instead. Two ink tiers rather than two equal lines — the second one is
 * the useful one and should read as an instruction, not as more error.
 * `role="status"` because the composer keeps focus: someone who never looks down
 * is still told that nothing was sent.
 */
function SlashRefusal(props: { because: string; instead: string | null }) {
  return (
    <Stack className="nv-slash-refusal" role="status">
      <Text className="nv-slash-refusal__because">{props.because}</Text>
      {props.instead && <Text className="nv-slash-refusal__instead">{props.instead}</Text>}
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
