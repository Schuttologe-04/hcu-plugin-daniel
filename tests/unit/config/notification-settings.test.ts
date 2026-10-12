import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/config-schema.js';
import { getNotificationSettings } from '../../../src/config/notification-settings.js';
import { makeConfig } from '../load-management/helpers.js';

describe('notification configuration extension', () => {
  const defaults = {
    intervention: false, controllerConnectionError: false,
    chargerConnectionError: false, interactive: true,
  };

  it('keeps original validated output unchanged when preferences are absent', () => {
    const config = makeConfig();
    expect(validateConfig(config)).toEqual({ ok: true, value: config });
    expect(getNotificationSettings(config)).toEqual(defaults);
  });

  it('accepts four native boolean preferences', () => {
    const config = { ...makeConfig(), notifications: { ...defaults, intervention: true } };
    expect(validateConfig(config)).toEqual({ ok: true, value: config });
    expect(getNotificationSettings(config).intervention).toBe(true);
  });

  it.each(['intervention', 'controllerConnectionError', 'chargerConnectionError', 'interactive'])(
    'rejects missing preference %s', (key) => {
      const notifications: Record<string, unknown> = { ...defaults };
      delete notifications[key];
      expect(validateConfig({ ...makeConfig(), notifications }).ok).toBe(false);
    },
  );

  it.each([null, false, [], 'true', {}])('rejects invalid notification object %j', (notifications) => {
    expect(validateConfig({ ...makeConfig(), notifications }).ok).toBe(false);
  });

  it.each(['false', 0, 1, null, undefined])('does not coerce notification values %j', (intervention) => {
    expect(validateConfig({ ...makeConfig(), notifications: { ...defaults, intervention } }).ok).toBe(false);
  });

  it('strips unknown credential fields at all persisted model levels', () => {
    const validated = validateConfig({ ...makeConfig(), HCU_AUTHTOKEN: 'private',
      notifications: { ...defaults, authtoken: 'private' } });
    expect(validated.ok).toBe(true);
    expect(JSON.stringify(validated)).not.toContain('private');
  });
});
