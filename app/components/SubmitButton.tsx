'use client';

import { useFormStatus } from 'react-dom';

/**
 * Submit button that disables itself while its form is pending. Every action here can spend a
 * metered API request, so a double-click must not become two requests.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  confirm,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'quiet';
  /** Shown in a confirm dialog before submitting — used where an action spends several requests. */
  confirm?: string;
}) {
  const { pending } = useFormStatus();

  const base =
    'rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
  const styles =
    variant === 'primary'
      ? 'bg-accent text-bg hover:opacity-90'
      : 'border border-border bg-surface text-muted hover:text-text';

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(event) => {
        if (confirm !== undefined && !window.confirm(confirm)) event.preventDefault();
      }}
      className={`${base} ${styles}`}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
