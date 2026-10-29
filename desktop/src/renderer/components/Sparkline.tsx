// A tiny SVG line of values sampled from status polling while the app is open.

import { t } from '../i18n';

export function Sparkline({ values, label, height = 48 }: { values: number[]; label: string; height?: number }) {
  const width = 300;
  if (values.length < 2) {
    return <div className="grid h-12 place-items-center text-[12px] text-muted">{t('spark.collecting')}</div>;
  }
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="var(--tc-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
