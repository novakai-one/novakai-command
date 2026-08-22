import type {
  BenchPendingPlacement,
  BenchRemovalUndo,
} from '../model/use-bench-placement-interaction';
import './PlacementFeedback.css';

/** World-space preview that follows the pointer without becoming a canvas node. */
export function ConversationPlacementGhost({
  placement,
}: {
  readonly placement: BenchPendingPlacement;
}) {
  return (
    <div
      className="bench-placement-ghost"
      style={{ left: placement.point.x, top: placement.point.y }}
      aria-hidden="true"
    >
      <span className="bench-placement-ghost__avatar">{placement.initials}</span>
      <span className="bench-placement-ghost__copy">
        <strong>{placement.title}</strong>
        <small>Click the canvas to place</small>
      </span>
    </div>
  );
}

/** Screen-space mode indicator keeps direct placement visible and cancellable. */
export function PlacementModeNotice({
  placement,
  onCancel,
}: {
  readonly placement: BenchPendingPlacement;
  readonly onCancel: () => void;
}) {
  return (
    <div className="bench-placement-mode" role="status" aria-live="polite">
      <span><strong>Place</strong> {placement.title}</span>
      <small>Click empty canvas · Esc to cancel</small>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Short-lived inverse action for a Placement removal. */
export function PlacementUndoNotice({
  removal,
  onUndo,
  onDismiss,
}: {
  readonly removal: BenchRemovalUndo;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="bench-placement-undo" role="status" aria-live="polite">
      <span><strong>{removal.title}</strong> removed from the Bench</span>
      <button type="button" className="bench-placement-undo__action" onClick={onUndo}>Undo</button>
      <button
        type="button"
        className="bench-placement-undo__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
