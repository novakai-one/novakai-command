import { useState, type FormEvent } from 'react';
import './InlineDecisionForm.css';

/** Local-only ruling draft shared by normal and Zen Decision Request surfaces. */
export function InlineDecisionForm({
  requestId,
  onSubmit,
  onCancel,
}: {
  readonly requestId: string;
  readonly onSubmit: (ruling: string) => void;
  readonly onCancel: () => void;
}) {
  const [ruling, setRuling] = useState('');
  const [isSubmitted, setSubmitted] = useState(false);
  const trimmedRuling = ruling.trim();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedRuling || isSubmitted) return;
    onSubmit(trimmedRuling);
    setSubmitted(true);
    setRuling('');
  };

  return (
    <form className="bench-decision-form nodrag nowheel" onSubmit={handleSubmit}>
      <label htmlFor={`bench-ruling:${requestId}`}>Your ruling</label>
      <textarea
        id={`bench-ruling:${requestId}`}
        value={ruling}
        onChange={(event) => setRuling(event.target.value)}
        placeholder="State the decision…"
        rows={3}
        disabled={isSubmitted}
      />
      <span className="bench-action-row">
        <button type="button" className="bench-control-button" onClick={onCancel} disabled={isSubmitted}>Cancel</button>
        <button type="submit" className="bench-control-button bench-danger-action" disabled={!trimmedRuling || isSubmitted}>
          {isSubmitted ? 'Recorded' : 'Record decision'}
        </button>
      </span>
    </form>
  );
}
