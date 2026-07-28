// shell/ui/frame/inspectorVisibility.ts — G2 glitch fix: clicking a message
// set the inspector content, but a persisted collapsed layout kept the pane
// shut, so the click looked dead. Rule: a NEW inspect target always opens the
// pane; a manual close stays closed until the next inspect (a new content
// object); clearing content never opens anything.

interface InspectorContent { title: string; body: unknown }

/** Should the inspector auto-open for this inspect event? */
export function shouldAutoOpenInspector(
  prev: InspectorContent | null,
  next: InspectorContent | null,
  collapsed: boolean,
): boolean {
  return collapsed && next !== null && next !== prev;
}
