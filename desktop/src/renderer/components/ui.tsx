// Small UI primitives (shadcn-style, without the dependency): buttons, cards,
// badges, toggles, inputs, dialogs. Keyboard-first: native elements, visible
// focus, labelled controls.

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { t } from '../i18n';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 border-transparent',
  secondary: 'bg-panel-2 text-fg hover:bg-border border-border',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-panel-2 border-transparent',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25 border-bad/30',
};

export function Button({ variant = 'secondary', busy = false, icon, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** A button that runs an async action and shows it busy until it settles. */
export function ActionButton({ onAction, ...rest }: Omit<Parameters<typeof Button>[0], 'onClick'> & { onAction: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...rest}
      busy={busy}
      onClick={() => {
        setBusy(true);
        void onAction().finally(() => setBusy(false));
      }}
    />
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-border bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="truncate text-[13px] font-semibold tracking-wide text-fg">{title}</h2>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok border-ok/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-bad/15 text-bad border-bad/30',
  info: 'bg-info/15 text-info border-info/30',
  muted: 'bg-panel-2 text-muted border-border',
  accent: 'bg-accent/15 text-accent border-accent/30',
};

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[11px] font-medium', TONES[tone])}>
      {children}
    </span>
  );
}

const DOTS: Record<Tone, string> = {
  ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', muted: 'bg-muted', accent: 'bg-accent',
};

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', DOTS[tone], pulse && 'animate-pulse')} />;
}

export function Banner({ tone, title, children, actions }: { tone: Tone; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3', TONES[tone])}>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">{title}</div>
        {children && <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-fg/80">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cx('relative flex items-start justify-between gap-4 py-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-[13px] text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] text-muted">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cx(
          'relative mt-0.5 inline-block h-5 w-9 shrink-0 rounded-full border border-border transition-colors',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2',
          checked ? 'bg-accent' : 'bg-panel-2',
        )}
      >
        <span className={cx('absolute top-0.5 size-3.5 rounded-full bg-fg transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </span>
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/** A form control sized by its caller (toolbars give it a fixed width). */
export const controlClass = 'min-w-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none';
/** A form control that fills its field. */
export const inputClass = `${controlClass} w-full`;

/** Text from a catalogue, with `backticked` parts rendered as code. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1
          ? <code key={i} className="font-mono text-[0.95em]">{part.slice(1, -1)}</code>
          : part)}
    </>
  );
}

const TEXT_TONES: Record<Tone, string> = {
  ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-fg', accent: 'text-accent',
};

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-panel px-4 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={cx('mt-1 truncate text-2xl font-semibold tabular-nums', tone ? TEXT_TONES[tone] : 'text-fg')}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-[14px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-md text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CopyButton({ text, label = t('common.copy'), onCopy }: { text: string; label?: string; onCopy: (text: string) => Promise<unknown> }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      className="px-2 py-1"
      icon={done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      onClick={() => {
        void onCopy(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {label}
    </Button>
  );
}

export function CodeBlock({ children, actions }: { children: string; actions?: ReactNode }) {
  return (
    <div className="relative rounded-md border border-border bg-bg">
      {actions && <div className="absolute right-1 top-1">{actions}</div>}
      <pre className="overflow-x-auto whitespace-pre p-3 pr-20 font-mono text-[12px] leading-relaxed text-fg">{children}</pre>
    </div>
  );
}

/** A modal confirmation. Escape cancels; focus starts on Cancel. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-lg border border-border bg-panel p-5 shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-[15px] font-semibold text-fg">{title}</h2>
        <div className="mt-2 text-[13px] text-muted">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-[13px] text-fg hover:bg-border">{t('common.cancel')}</button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
