// shell/ui/frame/Frame.tsx — rail │ workspace │ inspector.
// All three resizable + collapsible (SHL-003); geometry persists to the
// layout object (SHL-002: settings, not code). Breadcrumb: click → inspect in
// inspector → expand → breadcrumb back (DEC-S2 / APP-MODEL).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutRecord } from '../../contract/types.js';
import type { ShellServices } from '../../contract/services.js';
import { mintShellOpId } from '../../contract/services.js';
import { IconButton, Splitter } from '../kit/index.js';
import { shouldAutoOpenInspector } from './inspectorVisibility.js';
import { NavigationRail, type RailItem } from './NavigationRail.js';
import './frame.css';

export interface BreadcrumbItem { id: string; label: string }

export function Frame(props: {
  services: ShellServices;
  navItems: readonly RailItem[];
  currentView: string;
  onSelectView(key: string): void;
  workspace: React.ReactNode;
  inspector: { title: string; body: React.ReactNode } | null;
  breadcrumb: BreadcrumbItem[];
  onBreadcrumb(id: string | null): void;
}) {
  const [layout, setLayoutState] = useState<LayoutRecord | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    props.services.getLayout().then((res) => {
      if (!alive) return;
      // M4: typed Result — a failed read/materialise surfaces inline, never swallowed
      if (res.ok) setLayoutState(res.value.record);
      else setPersistError(res.error.message);
    });
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
      persistTimer.current = setTimeout(() => {
        // M4: surface setLayout failures as a small inline error — never void-swallowed
        void props.services.setLayout(merged, mintShellOpId()).then((res) => {
          setPersistError(res.ok ? null : res.error.message);
        });
      }, 400);
      return merged;
    });
  }, [props.services]);

  // G2: a NEW inspect target (click message/conversation) always opens the
  // pane — a persisted collapsed layout must not swallow the peek. A manual
  // close is respected until the NEXT inspect (content reference changes).
  const prevInspector = useRef<typeof props.inspector>(null);
  useEffect(() => {
    if (layout && shouldAutoOpenInspector(prevInspector.current, props.inspector, layout.inspector.collapsed)) {
      applyPatch({ inspector: { ...layout.inspector, collapsed: false } });
    }
    prevInspector.current = props.inspector;
  }, [props.inspector, layout, applyPatch]);

  // layout read failed at the seam — draw the error, never a blank frame
  if (!layout) {
    return persistError ? (
      <div className="nv-frame"><p className="nv-persist-error" role="alert">Layout could not be loaded: {persistError}</p></div>
    ) : null; // layout read is instant; blank paint avoided by CSS ground
  }

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  // The rail is the ported sandbox NavigationRail: fixed sandbox widths (its
  // CSS owns them), so the old width splitter is gone; collapse remains the
  // persisted layout fact it always was (SHL-002).
  const railEl = (
    <NavigationRail
      items={props.navItems}
      currentKey={props.currentView}
      onSelect={props.onSelectView}
      collapsed={layout.rail.collapsed}
      onToggleCollapse={() => applyPatch({ rail: { ...layout.rail, collapsed: !layout.rail.collapsed } })}
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
      {persistError && (
        <p className="nv-persist-error" role="alert"
           style={{ position: 'absolute', bottom: 8, right: 12, margin: 0, fontSize: 12 }}>
          Layout change not saved: {persistError}
        </p>
      )}
      {layout.rail.side === 'left' && railEl}
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
      {layout.rail.side === 'right' && railEl}
    </div>
  );
}
