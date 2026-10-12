import type { AppConfig, NotificationSettings } from './config-types.js';

/** Notifications require explicit opt-in; no question is sent on startup. */
export function getNotificationSettings(config: AppConfig): NotificationSettings {
  return config.notifications ?? {
    intervention: false,
    controllerConnectionError: false,
    chargerConnectionError: false,
    interactive: true,
  };
}
