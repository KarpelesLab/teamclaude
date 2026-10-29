import type { Translate } from './i18n';

export function distributionLabel(mode: string | null | undefined, t: Translate): string {
  switch (mode) {
    case 'on': case 'even': return t('dist.even');
    case 'off': return t('dist.off');
    case 'adaptive': return t('dist.adaptive');
    case 'load': return t('dist.load');
    default: return mode ?? t('common.unknown');
  }
}
