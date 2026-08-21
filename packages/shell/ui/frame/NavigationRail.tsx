/**
 * The product areas — ported from the sandbox NavigationRail (main @ 9df2842).
 * navigation-rail.css is byte-identical to the sandbox file; this component is
 * the wiring adaptation the migration plan names (M1-11): entries are the
 * screens App.tsx really mounts, selection goes through the shell's setView,
 * collapse state is the host's persisted layout fact, and the sandbox rail's
 * count badges / gold attention row / dev design-switcher render only when
 * their data owners exist — none do yet, so none render (M1-04).
 */
import React from 'react';
import './navigation-rail.css';

export type RailItem = { key: string; label: string };

const ICON: Record<string, string> = {
  messaging: 'M3 4.5h14v9H8l-4 3.5V13.5H3Z',
  agents: 'M10 3.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4 17c0-3 2.7-5 6-5s6 2 6 5',
  runs: 'M10 2.5A7.5 7.5 0 1 0 17.5 10M10 6.5A3.5 3.5 0 1 0 13.5 10M10 10l6-6',
  family: 'M3 9.2 10 3.5l7 5.7V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1Z',
  communications: 'M10 2.5 17.5 7v6L10 17.5 2.5 13V7Zm0 4.2L6.4 8.8v2.4L10 13.3l3.6-2.1V8.8Z',
  sessions: 'M3 4.5h5.5v11H3Zm6.5 0H15v6.5H9.5Zm0 7.5H15v3.5H9.5Z',
  watchers: 'M2.5 10c2-4 4.5-5.5 7.5-5.5s5.5 1.5 7.5 5.5c-2 4-4.5 5.5-7.5 5.5S4.5 14 2.5 10Zm7.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  notifications: 'M10 2.5c3 0 5 2.2 5 5v3l1.5 2.5v1h-13v-1L5 10.5v-3c0-2.8 2-5 5-5Zm-2 12.5a2 2 0 0 0 4 0',
  settings: 'M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0-4v2m0 11v2m7.5-7.5h-2m-11 0h-2m10.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m10.6 0-1.4-1.4M6.1 6.1 4.7 4.7',
};

const STROKE_ICONS: ReadonlySet<string> = new Set(['runs', 'agents', 'watchers', 'settings']);

export function NavigationRail(props: {
  items: readonly RailItem[];
  currentKey: string;
  onSelect(key: string): void;
  collapsed: boolean;
  onToggleCollapse(): void;
}) {
  const { collapsed } = props;

  return (
    <nav className="navigation-rail" data-collapsed={collapsed} aria-label="Product areas">
      <div className="navigation-rail__top">
        <span className="navigation-rail__wordmark">{collapsed ? '>_' : '>_ novakai'}</span>
        <button
          type="button"
          className="navigation-rail__collapse"
          onClick={props.onToggleCollapse}
          aria-label={collapsed ? 'Expand the rail' : 'Collapse the rail'}
          title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <ul className="navigation-rail__rows">
        {props.items.map(({ key, label }) => (
          <li key={key}>
            <button
              type="button"
              className="navigation-rail__row"
              data-current={props.currentKey === key}
              aria-current={props.currentKey === key ? 'page' : undefined}
              title={label}
              onClick={() => props.onSelect(key)}
            >
              <svg className="navigation-rail__icon" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d={ICON[key] ?? ICON.sessions}
                  fill={STROKE_ICONS.has(key) ? 'none' : 'currentColor'}
                  stroke={STROKE_ICONS.has(key) ? 'currentColor' : 'none'}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="navigation-rail__label">{label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="navigation-rail__footer">
        <span className="navigation-rail__person" title="Chris">CD</span>
        <span className="navigation-rail__label navigation-rail__person-name">Chris</span>
      </div>
    </nav>
  );
}
