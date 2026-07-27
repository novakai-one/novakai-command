// shell/ui/frame/Frame.tsx — rail │ workspace │ inspector.
// All three resizable + collapsible (SHL-003); geometry persists to the
// layout object (SHL-002: settings, not code). Breadcrumb: click → inspect in
// inspector → expand → breadcrumb back (DEC-S2 / APP-MODEL).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutRecord } from '../../contract/types.js';
import type { ShellServices } from '../../contract/services.js';
import { IconButton, Splitter } from '../kit/index.js';
import './frame.css';

export interface BreadcrumbItem { id: string; label: string }

export function Frame(props: {
  services: ShellServices;
  rail: React.ReactNode;
  workspace: React.ReactNode;
  inspector: { title: string; body: React.ReactNode } | null;
  breadcrumb: BreadcrumbItem[];
  onBreadcrumb(id: string | null): void;
  railTop?: React.ReactNode;
}) {
  const [layout, setLayoutState] = useState<LayoutRecord | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    props.services.getLayout().then(({ record }) => { if (alive) setLayoutState(record); });
    return () => { alive = false; };
  }, [props.services]);

  const applyPatch = useCallback((patch: Partial<LayoutRecord>) => {
    setLayoutState((cur) => {
      if (!cur) return cur;
      const merged: LayoutRecord = {
        ...cur, ...patch,
        rail: { ...cur.rail, ...(patch.rail ?? {}) },
        workspace: { ...cur.workspace, ...(patch.workspace ?? {}) },
        inspector: { ...cur.inspector, ...(patch.inspector ?? {}) },
        composer: { ...cur.composer, ...(patch.composer ?? {}) },
      };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => { void props.services.setLayout(merged); }, 400);
      return merged;
    });
  }, [props.services]);

  if (!layout) return null; // layout read is instant; blank paint avoided by CSS ground

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const railEl = (
    <nav className="nv-rail" data-collapsed={layout.rail.collapsed ? 'true' : 'false'}
         style={{ width: layout.rail.collapsed ? 52 : layout.rail.width }}
         aria-label="Rail">
      <div className="nv-wordmark">&gt;_ <span>Novakai</span></div>
      {props.railTop}
      {props.rail}
      <IconButton
        className="nv-collapse-btn"
        label={layout.rail.collapsed ? 'Expand rail' : 'Collapse rail'}
        onClick={() => applyPatch({ rail: { ...layout.rail, collapsed: !layout.rail.collapsed } })}
      >{layout.rail.collapsed ? '»' : '«'}</IconButton>
    </nav>
  );

  const railSplitter = !layout.rail.collapsed && (
    <Splitter label="Resize rail"
      onDelta={(d) => applyPatch({ rail: { ...layout.rail, width: clamp(layout.rail.width + (layout.rail.side === 'left' ? d : -d), 180, 480) } })}
      onDoubleClick={() => applyPatch({ rail: { ...layout.rail, collapsed: true } })}
    />
  );

  const inspectorEl = props.inspector && (
    <aside className="nv-inspector" style={{ width: layout.inspector.collapsed ? 0 : layout.inspector.width }}
           aria-label="Inspector" aria-hidden={layout.inspector.collapsed}>
      {!layout.inspector.collapsed && (
        <>
          <header className="nv-inspector__head">
            <span className="nv-inspector__title">{props.inspector.title}</span>
            <IconButton label="Expand in workspace" onClick={() => props.onBreadcrumb('__expand__')}>⤢</IconButton>
            <IconButton label="Close inspector"
              onClick={() => applyPatch({ inspector: { ...layout.inspector, collapsed: true } })}>×</IconButton>
          </header>
          <div className="nv-inspector__body">{props.inspector.body}</div>
        </>
      )}
    </aside>
  );

  return (
    <div className="nv-frame">
      {layout.rail.side === 'left' && <>{railEl}{railSplitter}</>}
      <main className="nv-workspace" style={{ minWidth: layout.workspace.minWidth }}>
        {props.breadcrumb.length > 0 && (
          <nav className="nv-breadcrumb" aria-label="Breadcrumb">
            <button onClick={() => props.onBreadcrumb(null)}>‹ Back</button>
            {props.breadcrumb.map((b, i) => (
              <React.Fragment key={b.id}>
                <span>/</span>
                <button aria-current={i === props.breadcrumb.length - 1 ? 'page' : undefined}
                        onClick={() => props.onBreadcrumb(b.id)}>{b.label}</button>
              </React.Fragment>
            ))}
          </nav>
        )}
        {props.workspace}
      </main>
      {!layout.inspector.collapsed && props.inspector && (
        <Splitter label="Resize inspector"
          onDelta={(d) => applyPatch({ inspector: { ...layout.inspector, width: clamp(layout.inspector.width - d, 220, 560) } })}
        />
      )}
      {inspectorEl}
      {layout.rail.side === 'right' && <>{railSplitter}{railEl}</>}
    </div>
  );
}
