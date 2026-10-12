import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config-types.js';
import { validateConfig } from '../../../src/config/config-schema.js';
import { success } from '../../../src/domain/errors.js';
import type { ConfigStore } from '../../../src/hcu/config/config-store.js';
import { HcuConfigService } from '../../../src/hcu/config/hcu-config-service.js';
import type { HcuEnvelope, HcuSender } from '../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';
import { initialRuntimeSnapshot } from '../../../src/orchestration/runtime-snapshot.js';
import { allEnabledConfig, makeConfig } from '../load-management/helpers.js';

const booleanProperties = [
  'loadManagement.enabled',
  'chargers.garage.enabled',
  'chargers.links.enabled',
  'chargers.rechts.enabled',
  'notifications.intervention',
  'notifications.controllerConnectionError',
  'notifications.chargerConnectionError',
  'notifications.interactive',
] as const;

function setup(initialConfig: AppConfig) {
  const sent: HcuEnvelope[] = [];
  const saved: AppConfig[] = [];
  const sender: HcuSender = {
    pluginId: PLUGIN_ID,
    send: (message) => { sent.push(message); return true; },
  };
  const store: ConfigStore = {
    load: vi.fn(async () => success(null)),
    save: vi.fn(async (config: AppConfig) => {
      saved.push(structuredClone(config));
      return success(undefined);
    }),
  };
  const onConfigApplied = vi.fn<(config: AppConfig) => void>();
  const service = new HcuConfigService({
    pluginId: PLUGIN_ID, sender, store, initialConfig,
    getSnapshot: () => initialRuntimeSnapshot(), onConfigApplied,
  });
  const update = (properties: Readonly<Record<string, unknown>>) => service.handle({
    pluginId: PLUGIN_ID, id: 'boolean-update', type: 'CONFIG_UPDATE_REQUEST', body: { properties },
  });
  return { service, sent, saved, store, onConfigApplied, update };
}

describe('HCUweb unchecked checkbox configuration regression', () => {
  it('persists every false BOOLEAN value from textual or native HCUweb values as a complete validated configuration', async () => {
    const initialConfig: AppConfig = {
      ...allEnabledConfig(),
      notifications: { intervention: true, controllerConnectionError: true,
        chargerConnectionError: true, interactive: true },
    };
    const expected: AppConfig = {
      ...initialConfig,
      loadManagement: { ...initialConfig.loadManagement, enabled: false },
      chargers: initialConfig.chargers.map((charger) => ({ ...charger, enabled: false, host: '' })),
      notifications: { intervention: false, controllerConnectionError: false,
        chargerConnectionError: false, interactive: false },
    };
    for (const checkboxValue of [false, 'false']) {
      const { service, sent, saved, onConfigApplied, update } = setup(initialConfig);
      const properties = Object.fromEntries(booleanProperties.map((id) => [id, checkboxValue]));
      Object.assign(properties, { 'chargers.garage.host': '', 'chargers.links.host': '', 'chargers.rechts.host': '' });

      expect(await update(properties)).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ id: 'boolean-update', type: 'CONFIG_UPDATE_RESPONSE', body: { status: 'APPLIED' } });
      expect(service.current).toEqual(expected);
      expect(saved).toEqual([expected]);
      expect(onConfigApplied).toHaveBeenCalledExactlyOnceWith(expected);
      expect(validateConfig(saved[0])).toEqual(success(expected));
    }
  });

  it('still rejects the entire update when an enabled charger has no host', async () => {
    const initialConfig = makeConfig();
    const { service, sent, store, onConfigApplied, update } = setup(initialConfig);
    await update({
      'notifications.intervention': false,
      'controller.host': 'changed-controller.test',
      'chargers.rechts.enabled': true,
    });

    expect(sent[0]?.body?.['status']).toBe('FAILED');
    expect(service.current).toEqual(initialConfig);
    expect(store.save).not.toHaveBeenCalled();
    expect(onConfigApplied).not.toHaveBeenCalled();
  });

  it('still rejects malformed boolean types for all eight fields without a partial update', async () => {
    for (const id of booleanProperties) {
      const initialConfig = makeConfig();
      const { service, sent, store, onConfigApplied, update } = setup(initialConfig);
      await update({ 'controller.host': 'changed-controller.test', [id]: 0 });

      expect(sent[0]?.body?.['status']).toBe('FAILED');
      expect(service.current).toEqual(initialConfig);
      expect(store.save).not.toHaveBeenCalled();
      expect(onConfigApplied).not.toHaveBeenCalled();
    }
  });
});
