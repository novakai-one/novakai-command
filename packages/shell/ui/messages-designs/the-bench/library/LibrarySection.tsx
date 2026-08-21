import type { ReactNode } from 'react';

/** One labelled zone of the panel. Renders nothing when it holds nothing. */
export function LibrarySection({ label, count, children }: {
  label: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="library-section">
      <h3 className="library-section__label">
        {label}
        {typeof count === 'number' && <span>{count}</span>}
      </h3>
      {children}
    </section>
  );
}
