import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StudioRail, StudioWorkHead, type ViewMode } from './studio/index.js';
import { StudioChatPanel } from './studio/chat/index.js';
import { StudioResizeSeams } from './studio/resize.js';
import { OrganizationLens } from './workspace/organization/index.js';
import { AgentBoard } from './board/index.js';
import { buildToolPairs, selKey, visibilityPredicate } from './board/timelineModel.js';
import { SelectedInspector } from './details/index.js';
import { SessionBar } from './sessionbar/index.js';
import { RulesetInspector, RulesetData } from './ruleset/index.js';
import { SettingsPanel } from './settings/index.js';
import { DebugPanel, BuildMessage } from './debug/index.js';
import { FilesPanel } from './files/index.js';
import { SubTimeline, SubagentInspector, useSubagentState } from './subagent/index.js';
import { SidePanel } from './sidepanel/index.js';
import { AgentsView, useAgentsState } from './agents/index.js';
import { CanvasView, CANVAS_CHANGED_EVENT } from './canvas/index.js';
import { AnalyticsView, ANALYTICS_CHANGED_EVENT } from './analytics/index.js';
import { DesignView, DESIGN_CHANGED_EVENT } from './design/index.js';
import { useViewPanelState } from './viewpanel/index.js';
import { MessagesView } from './workspace/messages/index.js';
import { MissionControl } from './workspace/missionControl/index.js';
import { useProjectWorkspace } from '../lib/projectWorkspace/index.js';
import { useAttention } from '../lib/attention/index.js';
import { mergeEvents, upsertEvent } from '../lib/upsertEvents.js';
import { fetchUsage, useCostSettings, type SessionUsage } from '../lib/cost/index.js';
import { useTimeZone } from '../lib/timezone/index.js';
import './index.css';

/** Display-only '~' conversion for an absolute path. Never used for anything sent to the backend. */
export function toDisplayPath(absPath: string | null, homeDir: string | null): string {
  if (!absPath) return '';
  if (homeDir && (absPath === homeDir || absPath.startsWith(homeDir + '/'))) {
    return '~' + absPath.slice(homeDir.length);
  }
  return absPath;
}

export interface SessionMeta {
  sessionId: string;
  dirName: string;
  matchReason: 'cwd' | 'files';
  modified: number;
  size: number;
  title?: string;
}

export interface TranscriptEvent {
  kind: string;
  eventKey?: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  ts: string;
  isSidechain?: boolean;
  // text events
  text?: string;
  // tool_use events
  tool?: string;
  toolUseId?: string;
  input?: any;
  isAgentSpawn?: boolean;
  agentDescription?: string;
  agentPrompt?: string;
  agentType?: string;
  // tool_result events
  content?: string;
  isError?: boolean;
  // hook events
  hookName?: string;
  hookEvent?: string;
  // system events
  subtype?: string;
  // session_meta
  mode?: string;
  permissionMode?: string;
  summary?: string;
  // usage events (kind 'usage' — stripped from the events state; granular record + refetch trigger)
  model?: string;
  msgId?: string;
  usage?: { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };
}

const COL_MIN = 280;
const COL_MAX = 900;
const VIEW_MODE_STORAGE_KEY = 'novakai-view-mode';
const SESSION_STORAGE_KEY = 'novakai-selected-session';
// Restore-allowlist = the nav's visible tabs. A stored mode outside this set
// (e.g. 'ruleset' persisted before the nav cleanup) falls back to 'workspace'.
const VIEW_MODES = new Set<ViewMode>(['workspace', 'messages', 'files']);

function restoredViewMode(): ViewMode {
  const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return VIEW_MODES.has(stored as ViewMode) ? stored as ViewMode : 'workspace';
}

/** Invisible 6px strip between columns; highlights on hover, drag resizes the column to its right. */
function ResizeHandle({ width, onWidthChange }: { width: number; onWidthChange(width: number): void }) {
  const [dragging, setDragging] = useState(false);

  function handleMouseDown(event: React.MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(moveEvent: MouseEvent): void {
      onWidthChange(Math.min(COL_MAX, Math.max(COL_MIN, startWidth + startX - moveEvent.clientX)));
    }
    function onUp(): void {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className={dragging ? 'col-resize-handle col-resize-dragging' : 'col-resize-handle'}
      onMouseDown={handleMouseDown}
    />
  );
}

export function DashboardShell() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(
    () => localStorage.getItem(SESSION_STORAGE_KEY)
  );
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [selectedSubKey, setSelectedSubKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(restoredViewMode);
  const agentsState = useAgentsState();
  const workspace = useProjectWorkspace(agentsState.setActiveAgentId);
  const attention = useAttention();
  const immersiveView = viewMode === 'workspace' || viewMode === 'organization' || viewMode === 'messages';
  // Live agents belonging to the selected thread: chips in the work head, and
  // the newest one is the chat panel's runtime (same rule the old Projects
  // view used).
  const threadAgents = agentsState.agents.filter((agent) =>
    agent.projectId === workspace.selectedProject?.id && agent.threadId === workspace.selectedThread?.id);
  const runtimeAgent = [...threadAgents]
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0] ?? null;

  function openAgent(agentId: string): void {
    agentsState.setActiveAgentId(agentId);
    setViewMode('agents');
  }

  const [rulesetData, setRulesetData] = useState<RulesetData | null>(null);
  const [buildMessages, setBuildMessages] = useState<BuildMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(420);
  const [subTimelineWidth, setSubTimelineWidth] = useState(300);
  const [subagentWidth, setSubagentWidth] = useState(420);
  const viewPanel = useViewPanelState();
  // Repaints the whole tree once per timezone select so every timestamp
  // formatter picks up the new zone. Typing in the picker never fires this.
  useTimeZone();
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  const [costSettings, setCostSettings] = useCostSettings();

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (selectedSession) localStorage.setItem(SESSION_STORAGE_KEY, selectedSession);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  }, [selectedSession]);

  const webSocketRef = useRef<WebSocket | null>(null);
  // Mirrors for the ws onmessage closure, which only mounts once.
  const selectedSessionRef = useRef<string | null>(null);
  selectedSessionRef.current = selectedSession;
  const subagentLiveRef = useRef<((subagentId: string, event: TranscriptEvent) => void) | null>(null);

  // Debounced /api/usage refetch: fired per usage-bearing ws frame (main or
  // subagent); trailing debounce keeps re-parsing the jsonl files cheap.
  const usageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedMetaRef = useRef<{ dirName: string; sessionId: string } | null>(null);
  function refetchUsage(delayMs: number): void {
    if (usageTimerRef.current) clearTimeout(usageTimerRef.current);
    usageTimerRef.current = setTimeout(() => {
      const meta = selectedMetaRef.current;
      if (!meta) return;
      fetchUsage(meta.dirName, meta.sessionId)
        .then((data) => {
          if (data && selectedMetaRef.current?.sessionId === meta.sessionId) setSessionUsage(data);
        })
        .catch(() => {});
    }, delayMs);
  }

  // Resolve $HOME once, for '~'-relative display across the shell.
  useEffect(() => {
    fetch('/api/fs?path=~&showHidden=false')
      .then(res => res.json())
      .then(data => setHomeDir(data.path))
      .catch(() => {});
  }, []);

  // Load the persisted active repo on mount.
  useEffect(() => {
    fetch('/api/active-repo')
      .then(res => res.json())
      .then(data => setActiveRepo(data.activeRepo ?? null))
      .catch(() => {});
  }, []);

  // Load sessions when the active repo changes
  useEffect(() => {
    let cancelled = false;
    if (!activeRepo) {
      setSessions([]);
      setSelectedSession(null);
      return;
    }
    fetch('/api/sessions')
      .then(res => res.json())
      .then((data: SessionMeta[]) => {
        if (cancelled) return;
        setSessions(data);
        // Auto-select most recent; clear when the repo has no matches
        setSelectedSession((current) =>
          data.some((session) => session.sessionId === current)
            ? current
            : data[0]?.sessionId ?? null
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeRepo]);

  // Load ruleset data when the active repo changes
  useEffect(() => {
    let cancelled = false;
    fetch('/api/ruleset')
      .then(res => res.json())
      .then((data: RulesetData) => { if (!cancelled) setRulesetData(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeRepo]);

  const selectedMeta = sessions.find((session) => session.sessionId === selectedSession) ?? null;
  selectedMetaRef.current = selectedMeta ? { dirName: selectedMeta.dirName, sessionId: selectedMeta.sessionId } : null;

  // Load transcript when the selected session changes. Usage events are data,
  // not rows — stripped here so counts/turns/playback never see them; costs
  // come from /api/usage over the full files (visibility filters never apply).
  useEffect(() => {
    let cancelled = false;
    setSessionUsage(null);
    setEvents([]); // never show session A's timeline under session B's header while (or if) the fetch stalls
    if (!selectedMeta) return;
    fetch(`/api/transcript?project=${selectedMeta.dirName}&session=${selectedMeta.sessionId}`)
      .then(res => res.json())
      .then((data: TranscriptEvent[]) => {
        if (cancelled) return;
        // Live ws frames may have landed while the fetch was in flight; upsert
        // them over the file snapshot instead of clobbering them (the watcher
        // emits each appended line exactly once).
        setEvents(prev => mergeEvents(
          data.filter(event => event.kind !== 'usage'),
          prev,
        ));
      })
      .catch(() => {});
    refetchUsage(0);
    return () => { cancelled = true; };
  }, [selectedMeta]);

  // WebSocket for live updates
  useEffect(() => {
    const wsUrl = `ws://${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    webSocketRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.event === 'transcript-event') {
        // Drop events from a stale watcher during session switches.
        const matches = message.payload?.sessionId === selectedSessionRef.current;
        if (matches && message.payload?.kind === 'usage') {
          refetchUsage(1500); // usage events never enter the events state; they trigger a re-aggregate
        } else {
          setEvents(prev => (matches ? upsertEvent(prev, message.payload) : prev));
        }
      } else if (message.type === 'subagent-event') {
        // Subagent tails stream over the same socket; their usage growth must
        // refresh costs, and their rows feed the live sub timeline.
        if (message.sessionId === selectedSessionRef.current) {
          if (message.event?.kind === 'usage') refetchUsage(1500);
          if (message.subagentId && message.event) subagentLiveRef.current?.(message.subagentId, message.event);
        }
      } else if (message.event === 'watch-started' || message.event === 'messaging-v2') {
        // Watch acks and capability frames (consumed via the agentSocket
        // singleton) must not fall through to the debug message list.
      } else if (message.event === 'design-event') {
        // External design commit (bounded CLI, html-builder app) — the always-
        // mounted DesignView listens for this and refetches the accepted revision.
        window.dispatchEvent(new CustomEvent(DESIGN_CHANGED_EVENT, { detail: message.payload }));
      } else if (message.event === 'canvas-event') {
        // External canvas write (the ./canvas CLI, an editor) — the always-
        // mounted CanvasView listens for this and reloads its document.
        window.dispatchEvent(new CustomEvent(CANVAS_CHANGED_EVENT, { detail: message.payload }));
      } else if (message.event === 'analytics-event') {
        // Analyzer run lifecycle — the Analytics lens refreshes its result.
        window.dispatchEvent(new CustomEvent(ANALYTICS_CHANGED_EVENT, { detail: message.payload }));
      } else if (message.event === 'build-session' && message.payload?.sessionId && message.payload?.projectDir) {
        const { sessionId, projectDir } = message.payload;
        setSessions(prev => prev.some(session => session.sessionId === sessionId)
          ? prev
          : [{ sessionId, dirName: projectDir, matchReason: 'cwd', modified: Date.now(), size: 0 }, ...prev]);
        setSelectedSession(sessionId);
        // Same resets as a SessionBar switch — stale selections must not outlive their session.
        setSelectedEventKey(null);
        setSelectedSubKey(null);
      } else if (!message.type) {
        // Build/agent events. Type-keyed frames (agents-changed etc.) belong to
        // the agentSocket dialect and are broadcast to every socket — not ours.
        setBuildMessages(prev => [...prev, message]);
      }
    };

    // StrictMode's mount/unmount/mount cycle closes the first socket while it
    // is still CONNECTING, which makes the browser log a console error
    // ("WebSocket is closed before the connection is established"). Defer the
    // close until the handshake finishes; an open socket closes directly.
    return () => {
      if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close();
      else socket.close();
    };
  }, []);

  // Start watching when session is selected and in live mode
  useEffect(() => {
    if (!selectedMeta || !webSocketRef.current) return;
    const socket = webSocketRef.current;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'watch-session', project: selectedMeta.dirName, session: selectedMeta.sessionId }));
    }
  }, [selectedMeta, webSocketRef.current?.readyState]);

  const selectedEvent = useMemo(() => events.find(e => selKey(e) === selectedEventKey), [events, selectedEventKey]);
  const subagentState = useSubagentState(selectedMeta?.dirName ?? null, selectedSession);
  subagentLiveRef.current = subagentState.onLiveEvent;
  // Derived from live subEvents so streaming updates to the selected sub event render, not a click-time snapshot.
  const selectedSubEvent = useMemo(
    () => subagentState.subEvents.find(e => selKey(e) === selectedSubKey) ?? null,
    [subagentState.subEvents, selectedSubKey],
  );

  // Visibility filters apply to the timeline only; the view panel and stats see everything.
  // Pairing indexes toolUseIds from ALL tool_use events (hidden or not) so hiding a tool
  // category drops its results too, while hidden results are excluded so their chips go away.
  const { visibleEvents, pairs } = useMemo(() => {
    const predicate = visibilityPredicate(viewPanel.hiddenEvents);
    return {
      visibleEvents: events.filter(predicate),
      pairs: buildToolPairs(events.filter((event) => event.kind !== 'tool_result' || predicate(event))),
    };
  }, [events, viewPanel.hiddenEvents]);

  // Sub-event selection survives main-timeline clicks; only clicking a spawn
  // (which switches the focused subagent) resets the sub columns.
  function selectMainEvent(event: TranscriptEvent | null): void {
    setSelectedEventKey(event ? selKey(event) : null);
    if (event?.isAgentSpawn && event.toolUseId) {
      subagentState.focusSpawn(event.toolUseId);
      setSelectedSubKey(null);
    }
  }

  function selectSubEvent(event: TranscriptEvent | null): void {
    setSelectedSubKey(event ? selKey(event) : null);
  }

  return (
    <div className="studio-stage">
      <div className={immersiveView ? 'studio-app studio-app-immersive' : 'studio-app'}>
        <StudioWorkHead
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          sessionAgents={threadAgents}
          agents={agentsState.agents}
          project={workspace.selectedProject}
          thread={workspace.selectedThread}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {!immersiveView && <StudioRail
          projects={workspace.projects}
          selectedProject={workspace.selectedProject}
          selectedThread={workspace.selectedThread}
          onSelectProject={workspace.selectProject}
          onSelectThread={workspace.selectThread}
          onCreateProject={workspace.createProject}
          onCreateThread={workspace.createThread}
        />}
        <main className="studio-work">
          <div className="studio-work-body">
        {/* Left drawer is page-owned: the agents list only exists on the Agents
            tab (Files brings its own tree rail; other tabs have no drawer). */}
        {viewMode === 'agents' && (
          <SidePanel
            agents={agentsState.agents}
            activeAgentId={agentsState.activeAgentId}
            collapsed={agentsState.collapsed}
            onToggle={agentsState.toggleCollapsed}
            onSelect={(agentId) => agentsState.setActiveAgentId(agentId)}
            onCreate={agentsState.createAgent}
            onRename={agentsState.renameAgent}
            onKill={agentsState.killAgent}
            onArchive={agentsState.archiveAgent}
          />
        )}
        {/* Always mounted so agent terminals survive tab switches; hides itself via CSS. */}
        <AgentsView
          agents={agentsState.agents}
          activeAgentId={agentsState.activeAgentId}
          onCreate={agentsState.createAgent}
          visible={viewMode === 'agents'}
          costSettings={costSettings}
          onCostSettingsChange={setCostSettings}
        />
        {/* Always mounted so the map's pan/zoom and selection survive tab switches. */}
        <CanvasView visible={viewMode === 'canvas'} />
        {viewMode === 'analytics' && (
          <AnalyticsView repoPath={workspace.selectedProject?.rootPath ?? activeRepo} />
        )}
        {/* Always mounted so the prototype's shadow DOM survives tab switches. */}
        <DesignView visible={viewMode === 'design'} />
        {viewMode === 'messages' ? (
          <MessagesView
            agents={agentsState.agents}
            agentsLoaded={agentsState.agentsLoaded}
            projects={workspace.projects}
            project={workspace.selectedProject}
          />
        ) : viewMode === 'organization' ? (
          <OrganizationLens agents={agentsState.agents} />
        ) : viewMode === 'workspace' ? (
          <MissionControl
            agents={agentsState.agents}
            project={workspace.selectedProject}
            thread={workspace.selectedThread}
            projection={workspace.projection}
            attention={attention}
            usage={sessionUsage}
            selectedAgentId={agentsState.activeAgentId}
            onSelectAgent={(agentId) => agentsState.setActiveAgentId(agentId)}
            onReviewAttention={attention.goldThreadId
              ? () => workspace.selectThread(attention.goldThreadId!)
              : undefined}
          />
        ) : viewMode === 'files' ? (
          <FilesPanel
            homeDir={homeDir}
            activeRepo={activeRepo}
            onActiveRepoChange={setActiveRepo}
            onOpenAgents={() => setViewMode('agents')}
          />
        ) : viewMode === 'transcript' ? (
          <div className="shell-transcript-col shell-main">
            <SessionBar
              sessions={sessions}
              selectedSession={selectedSession}
              onSelectSession={(id) => { setSelectedSession(id); setSelectedEventKey(null); setSelectedSubKey(null); }}
              eventCount={events.length}
              subagentCount={subagentState.subagents.length}
              sessionUsage={sessionUsage}
              costSettings={costSettings}
              events={events}
              hiddenEvents={viewPanel.hiddenEvents}
              onToggleEvents={viewPanel.onToggle}
              variant={viewPanel.variant}
              onVariantChange={viewPanel.onVariantChange}
              onCostSettingsChange={setCostSettings}
            />
            <div className="shell-row">
              <AgentBoard
                events={events}
                visibleEvents={visibleEvents}
                pairs={pairs}
                onSelectEvent={selectMainEvent}
                selectedKey={selectedEventKey}
                variant={viewPanel.variant}
              />
              <ResizeHandle width={detailsWidth} onWidthChange={setDetailsWidth} />
              <div className="shell-col-resizable" style={{ width: detailsWidth }}>
                <SelectedInspector
                  event={selectedEvent}
                  events={visibleEvents}
                  onNavigate={selectMainEvent}
                />
              </div>
              <ResizeHandle width={subTimelineWidth} onWidthChange={setSubTimelineWidth} />
              <div className="shell-col-resizable" style={{ width: subTimelineWidth }}>
                <SubTimeline
                  {...subagentState}
                  onSelectSubEvent={selectSubEvent}
                  selectedSubKey={selectedSubKey}
                />
              </div>
              <ResizeHandle width={subagentWidth} onWidthChange={setSubagentWidth} />
              <div className="shell-col-resizable" style={{ width: subagentWidth }}>
                <SubagentInspector
                  meta={subagentState.selected}
                  subEvents={subagentState.subEvents}
                  event={selectedSubEvent}
                  onNavigate={selectSubEvent}
                  mainEvents={events}
                  sessionUsage={sessionUsage}
                  costSettings={costSettings}
                />
              </div>
            </div>
          </div>
        ) : viewMode === 'ruleset' ? (
          <div className="shell-main">
            <RulesetInspector data={rulesetData} />
          </div>
        ) : viewMode === 'debug' ? (
          <div className="shell-main">
            <DebugPanel
              buildMessages={buildMessages}
              wsReady={webSocketRef.current?.readyState === WebSocket.OPEN}
            />
          </div>
        ) : null}
          </div>
        </main>
        {!immersiveView && <StudioChatPanel
          project={workspace.selectedProject}
          thread={workspace.selectedThread}
          projection={workspace.projection}
          runtimeAgent={runtimeAgent}
          sessionUsage={sessionUsage}
          agents={agentsState.agents}
          onLaunch={workspace.launchProvider}
          onAttach={workspace.attachSession}
          onOpenAgent={openAgent}
        />}
        {!immersiveView && <StudioResizeSeams />}
      </div>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
