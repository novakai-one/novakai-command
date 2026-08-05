// tools/tabstrip-preview.tsx — a dev-only VISUAL proof of the tab strip.
//
// Why it exists: the standing rule is that no UI is reported as done until it
// has been driven in a real browser. The live terminal page needs a running
// nvk-server for its session socket, and the holdout browse harness is
// deliberately offline-only (README-BROWSE.md, "What this harness does NOT
// do") — so under the harness the real page can only prove its honest
// unreachable state. It does prove that, and that capture is part of this
// slice's evidence; but the STRIP itself would go to a seal unseen.
//
// This page closes that gap without faking a backed host. It mounts the real
// `TerminalChrome` with the real `TerminalTabStrip` and the real stylesheet,
// over literal entries. There is no fake `TerminalServices`, no fake socket and
// no second composition — a presentational component rendered with known props
// is not a composition of anything (the tracer's law, as seat 1 read it for
// runs-preview.tsx).
//
// Selection is REAL state, so a click in the browser proves the thing a static
// render cannot: that clicking a tab moves the selection to it.
//
// It shares ONE fixture builder with the deterministic suite, so the strip a
// human looks at and the strip the tests assert on cannot drift apart.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalChrome } from '../ui/screens/terminal/TerminalChrome.js';
import { TerminalTabStrip } from '../ui/screens/terminal/TerminalTabStrip.js';
import { composeTabStrip } from '../contract/terminalTabStrip.js';
import { describeTerminal } from '../contract/terminalServices.js';
import {
  SESSION_A, SESSION_B, SESSION_C, sessionView, tabRecord,
} from '../tests/fixtures/terminalTab.js';

// One tab per state that has to read correctly at a glance — including the two
// FZ-VIEW-034 names as places a Shell quietly starts lying.
const records = [
  tabRecord({ id: 'tab-build', title: 'build', terminalSessionId: SESSION_A }),
  // Untitled: it must still be a clickable, named thing.
  tabRecord({ id: 'tab-plain', title: '', terminalSessionId: SESSION_B }),
  // The Runtime reports nothing for this one. Not dropped, not zero, not exited.
  tabRecord({ id: 'tab-orphan', title: 'deploy', terminalSessionId: SESSION_C }),
];

const views = [
  sessionView({ terminalSessionId: SESSION_A, attachedControllerCount: 1 }),
  sessionView({ terminalSessionId: SESSION_B, status: 'recovery-required' }),
  // SESSION_C is deliberately absent.
];

function Preview(): React.JSX.Element {
  const [selectedTabId, setSelectedTabId] = useState<string | null>('tab-build');
  const entries = composeTabStrip(records, views);
  const selected = records.find((record) => record.id === selectedTabId);
  const view = views.find((item) => item.terminalSessionId === selected?.terminalSessionId);
  return (
    <TerminalChrome
      truth={view ? describeTerminal(view) : 'This tab\'s session is not reported by the Runtime'}
      tone={view?.status === 'recovery-required' ? 'attention' : 'calm'}
      watchingOnly={false}
      problem={null}
      surfaceRef={null}
      onClose={() => {}}
      strip={(
        <TerminalTabStrip
          entries={entries}
          selectedTabId={selectedTabId}
          onSelect={setSelectedTabId}
          onNewTab={() => {}}
        />
      )}
    />
  );
}

createRoot(document.getElementById('preview')!).render(<Preview />);
