// Local system notifications from state changes the app already observes.
// The same message is not repeated within REPEAT_MS, so a flapping account
// does not flood the notification centre.

import { Notification } from 'electron';
import type { Translate } from '../shared/i18n';
import type { BackendState, NotificationPrefs } from '../shared/types';
import { notificationsFor } from '../services/notification-rules';

const REPEAT_MS = 10 * 60_000;

export class Notifier {
  private prev: BackendState | null = null;
  private recent = new Map<string, number>();

  constructor(
    private readonly prefs: () => NotificationPrefs,
    private readonly t: () => Translate,
    private readonly onClick: () => void,
  ) {}

  handle(next: BackendState): void {
    const pending = notificationsFor(this.prev, next, this.t());
    this.prev = next;
    if (pending.length === 0 || !Notification.isSupported()) return;
    const prefs = this.prefs();
    const now = Date.now();
    for (const n of pending) {
      if (!prefs[n.kind]) continue;
      const key = `${n.kind}:${n.body}`;
      const last = this.recent.get(key);
      if (last !== undefined && now - last < REPEAT_MS) continue;
      this.recent.set(key, now);
      const notification = new Notification({ title: n.title, body: n.body });
      notification.on('click', this.onClick);
      notification.show();
    }
  }
}
