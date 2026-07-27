// shell/ui/kit/index.tsx — kit v1.1. The ONLY component library (red gate 3:
// screens compose kit components, nothing else). Calm by default.
// v1.1 (M8/DEC-S2-13, additive): RadioGroup, Select, Swatch — needed by the
// agent-def UI, accent picker, density picker. Old screens unbroken.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import './tokens.css';
import './kit.css';

// ── Buttons ─────────────────────────────────────────────────────────────────
export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const { primary, className, ...rest } = props;
  return <button className={`k-btn${primary ? ' k-btn--primary' : ''}${className ? ` ${className}` : ''}`} {...rest} />;
}

export function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const { label, className, ...rest } = props;
  return <button aria-label={label} title={label} className={`k-iconbtn${className ? ` ${className}` : ''}`} {...rest} />;
}

// ── Inputs ──────────────────────────────────────────────────────────────────
export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} className="k-input" {...props} />;
  },
);

// ── Choice controls (kit v1.1, M8/DEC-S2-13) ────────────────────────────────
export function RadioGroup(props: {
  label: string;
  options: ReadonlyArray<{ value: string; label?: React.ReactNode }>;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="k-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          data-on={props.value === o.value ? 'true' : 'false'}
          onClick={() => props.onChange(o.value)}
        >
          {o.label ?? o.value}
        </button>
      ))}
    </div>
  );
}

export function Select(props: {
  label: string;
  options: ReadonlyArray<{ value: string; label?: string }>;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <select
      className="k-select"
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
    </select>
  );
}

export function Swatch(props: {
  color: string;
  selected?: boolean;
  label: string;
  onSelect?(): void;
}) {
  return (
    <button
      type="button"
      className="k-swatch"
      style={{ background: props.color }}
      aria-label={props.label}
      aria-pressed={props.selected ? 'true' : 'false'}
      data-on={props.selected ? 'true' : 'false'}
      onClick={props.onSelect}
    />
  );
}

// ── List rows ───────────────────────────────────────────────────────────────
export function ListRow(props: {
  label: React.ReactNode;
  meta?: React.ReactNode;
  leading?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className="k-row" data-selected={props.selected ? 'true' : 'false'} onClick={props.onClick}>
      {props.leading}
      <span className="k-row__label">{props.label}</span>
      {props.meta != null && <span className="k-row__meta">{props.meta}</span>}
    </button>
  );
}

export function Badge(props: { children: React.ReactNode }) {
  return <span className="k-badge">{props.children}</span>;
}

// ── Panels ──────────────────────────────────────────────────────────────────
export function Panel(props: { head?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="k-panel" style={props.style}>
      {props.head && <header className="k-panel__head">{props.head}</header>}
      {props.children}
    </section>
  );
}

// ── Labelled field (kit v1.1) — one label + one control + optional hint ─────
export function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="k-field">
      <div className="k-field__label">{props.label}</div>
      {props.hint && <div className="k-field__hint">{props.hint}</div>}
      {props.children}
    </div>
  );
}

// ── Layout primitive (kit v1.1) — screens never write raw containers ───────
export function Stack(props: {
  horizontal?: boolean;
  gap?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`k-stack${props.horizontal ? ' k-stack--horizontal' : ''}${props.className ? ` ${props.className}` : ''}`}
      style={{ ...(props.gap !== undefined ? { gap: props.gap } : {}), ...props.style }}
    >
      {props.children}
    </div>
  );
}

// ── Inline typed error (kit v1.1) — failures are drawn, never blank ────────
export function InlineError(props: { children: React.ReactNode }) {
  return <div className="k-error" role="alert">{props.children}</div>;
}

export function EmptyState(props: { children: React.ReactNode }) {
  return <div className="k-empty">{props.children}</div>;
}

// ── Splitter (resizable) ────────────────────────────────────────────────────
export function Splitter(props: {
  horizontal?: boolean;
  onDelta(deltaPx: number): void;
  onDoubleClick?: () => void;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    last.current = props.horizontal ? e.clientY : e.clientX;
    setDragging(true);
  }, [props.horizontal]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const pos = props.horizontal ? e.clientY : e.clientX;
    props.onDelta(pos - last.current);
    last.current = pos;
  }, [dragging, props]);
  const stop = useCallback(() => setDragging(false), []);
  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation={props.horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      className={`k-splitter${props.horizontal ? ' k-splitter--horizontal' : ''}`}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={props.onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') props.onDelta(-16);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') props.onDelta(16);
      }}
    />
  );
}

// ── Scroll area ─────────────────────────────────────────────────────────────
export const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ScrollArea(props, ref) {
    const { className, ...rest } = props;
    return <div ref={ref} className={`k-scroll${className ? ` ${className}` : ''}`} {...rest} />;
  },
);

// ── Presence dot (dedicated liveness tokens — never the accent, R3-25) ──────
export function PresenceDot(props: { state: 'offline' | 'online' | 'active'; live?: boolean; title?: string }) {
  return (
    <span
      className="k-presence"
      data-state={props.state}
      data-live={props.live ? 'true' : 'false'}
      title={props.title ?? props.state}
      role="img"
      aria-label={props.title ?? `presence: ${props.state}`}
    />
  );
}

// ── Typing bubble (iPhone-style; motion only when live/focused — M-19) ──────
export function TypingBubble(props: { live?: boolean }) {
  return (
    <span className="k-typing" data-live={props.live ? 'true' : 'false'} role="status" aria-label="typing">
      <i /><i /><i />
    </span>
  );
}

// ── Composer input ──────────────────────────────────────────────────────────
export function ComposerInput(props: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  placeholder?: string;
  height: number;
  onResize(deltaPx: number): void;
  hint?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="k-composer" style={{ height: props.height }}>
      <Splitter horizontal label="Resize composer" onDelta={(d) => props.onResize(-d)} />
      <textarea
        ref={ref}
        value={props.value}
        placeholder={props.placeholder ?? 'Message — / for commands'}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />
      <div className="k-composer__hint">
        <span>{props.hint ?? 'Enter to send · Shift+Enter for a new line'}</span>
      </div>
    </div>
  );
}
