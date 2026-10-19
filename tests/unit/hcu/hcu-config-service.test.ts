import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config-types.js';
import { failure, success } from '../../../src/domain/errors.js';
import { HcuConfigService, applyHcuConfigProperties } from '../../../src/hcu/config/hcu-config-service.js';
import type { ConfigStore } from '../../../src/hcu/config/config-store.js';
import type { ConfigUpdateRequest, HcuEnvelope, HcuSender } from '../../../src/hcu/message-types.js';
import { initialRuntimeSnapshot } from '../../../src/orchestration/runtime-snapshot.js';
import { makeConfig } from '../load-management/helpers.js';

const pluginId = 'test.plugin';

function update(properties: Readonly<Record<string, unknown>>, id = 'update-1', languageCode = 'de'): ConfigUpdateRequest {
  return { pluginId, id, type: 'CONFIG_UPDATE_REQUEST', body: { properties, languageCode } };
}

function setup() {
  const sent: HcuEnvelope[] = [];
  const sender: HcuSender = { pluginId, send: (message) => { sent.push(message); return true; } };
  const saved: AppConfig[] = [];
  const store: ConfigStore = {
    load: vi.fn(async () => success(null)),
    save: vi.fn(async (config: AppConfig) => { saved.push(structuredClone(config)); return success(undefined); }),
  };
  const onConfigApplied = vi.fn<(config: AppConfig) => void | Promise<void>>();
  const onRecoveryFailed = vi.fn<() => void | Promise<void>>();
  const getSnapshot = vi.fn(() => initialRuntimeSnapshot());
  const service = new HcuConfigService({ pluginId, sender, store, initialConfig: makeConfig(), getSnapshot, onConfigApplied, onRecoveryFailed });
  return { service, sent, saved, store, onConfigApplied, onRecoveryFailed, getSnapshot };
}

describe('HCU config update mapping', () => {
  it('applies native and strict textual values through the existing full validation', () => {
    const result = applyHcuConfigProperties(makeConfig(), {
      'controller.host': 'new-controller.test',
      'loadManagement.gridLimitW': '20000',
      'loadManagement.enabled': 'true',
      'chargers.rechts.host': 'rechts.test',
      'chargers.rechts.enabled': true,
      'chargers.garage.priority': '2',
      'notifications.intervention': 'true',
      'notifications.interactive': false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid configuration');
    expect(result.value.controller.host).toBe('new-controller.test');
    expect(result.value.chargers[2]).toMatchObject({ host: 'rechts.test', enabled: true });
    expect(result.value.notifications).toEqual({ intervention: true, interactive: false,
      controllerConnectionError: false, chargerConnectionError: false });
  });

  it.each([
    'loadManagement.ampStep', 'loadManagement.targetGridW', 'loadManagement.recoveryThresholdW',
    'diagnostics.engineState', 'chargers.garage.amp', 'chargers.garage.car',
    'HCU_AUTHTOKEN', 'authtoken', 'credentials', '__proto__', 'chargers.other.host',
  ])('rejects readonly/unknown credential property %s', (id) => {
    expect(applyHcuConfigProperties(makeConfig(), { [id]: 1 }).ok).toBe(false);
  });

  it.each(['', ' ', 'false ', 'yes', 0, 1, null, {}, []])('rejects ambiguous boolean value %j', (value) => {
    expect(applyHcuConfigProperties(makeConfig(), { 'loadManagement.enabled': value }).ok).toBe(false);
  });

  it.each(['', ' ', '0x10', 'NaN', 'Infinity', '19000 watts', ' 19000 ', null, {}])('rejects ambiguous numeric value %j', (value) => {
    expect(applyHcuConfigProperties(makeConfig(), { 'loadManagement.gridLimitW': value }).ok).toBe(false);
  });

  it('refuses a charger slot absent from the central configuration', () => {
    const config = makeConfig({ chargers: [] });
    expect(applyHcuConfigProperties(config, { 'chargers.garage.host': 'garage.test' }).ok).toBe(false);
  });

  it('does not mutate the source configuration even when a later property fails', () => {
    const config = makeConfig();
    expect(applyHcuConfigProperties(config, { 'controller.host': 'moved.test', 'chargers.garage.priority': 0 }).ok).toBe(false);
    expect(config).toEqual(makeConfig());
  });
});

describe('HcuConfigService atomic persistence and protocol', () => {
  it('responds with template using the same documented request id', async () => {
    const { service, sent, getSnapshot, store } = setup();
    expect(await service.handle({ pluginId, id: 'template-1', type: 'CONFIG_TEMPLATE_REQUEST', body: {} })).toBe(true);
    expect(sent[0]).toMatchObject({ pluginId, id: 'template-1', type: 'CONFIG_TEMPLATE_RESPONSE' });
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('persists completely validated state before swapping runtime and replies APPLIED', async () => {
    const { service, sent, saved, onConfigApplied } = setup();
    onConfigApplied.mockImplementation((config) => {
      expect(saved.at(-1)).toEqual(config);
    });
    await service.handle(update({ 'loadManagement.gridLimitW': 20_000 }));
    expect(service.current.loadManagement.gridLimitW).toBe(20_000);
    expect(saved).toEqual([service.current]);
    expect(onConfigApplied).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ id: 'update-1', type: 'CONFIG_UPDATE_RESPONSE', body: { status: 'APPLIED' } });
  });

  it('rejects the complete update with no persist/runtime effects when one property is invalid', async () => {
    const { service, sent, store, onConfigApplied } = setup();
    await service.handle(update({ 'controller.host': 'changed.test', 'chargers.garage.priority': 0 }));
    expect(service.current).toEqual(makeConfig());
    expect(store.save).not.toHaveBeenCalled();
    expect(onConfigApplied).not.toHaveBeenCalled();
    expect(sent[0]?.body?.['status']).toBe('FAILED');
  });

  it('retains the previous valid runtime when persistence reports failure', async () => {
    const { service, sent, store, onConfigApplied } = setup();
    vi.mocked(store.save).mockResolvedValueOnce(failure('ConfigurationError', 'sensitive filesystem contents'));
    await service.handle(update({ 'controller.host': 'changed.test' }));
    expect(service.current).toEqual(makeConfig());
    expect(onConfigApplied).not.toHaveBeenCalled();
    expect(sent[0]?.body?.['status']).toBe('FAILED');
    expect(JSON.stringify(sent)).not.toContain('sensitive');
  });

  it('contains unexpected store rejections without leaking the exception payload', async () => {
    const { service, sent, store, onConfigApplied } = setup();
    vi.mocked(store.save).mockRejectedValueOnce(new Error('private token'));
    await expect(service.handle(update({ 'controller.host': 'changed.test' }))).resolves.toBe(true);
    expect(service.current).toEqual(makeConfig());
    expect(onConfigApplied).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain('private token');
  });

  it('defensively restores previous persisted configuration if a runtime adapter fails', async () => {
    const { service, saved, sent, onConfigApplied, onRecoveryFailed } = setup();
    onConfigApplied.mockRejectedValueOnce(new Error('runtime adapter failure'));
    await service.handle(update({ 'controller.host': 'changed.test' }));
    expect(service.current).toEqual(makeConfig());
    expect(saved.at(-1)).toEqual(makeConfig());
    expect(onConfigApplied).toHaveBeenLastCalledWith(makeConfig());
    expect(sent[0]?.body?.['status']).toBe('FAILED');
    expect(onRecoveryFailed).not.toHaveBeenCalled();
  });

  it.each(['result', 'throw'] as const)('blocks control and further updates if disk rollback fails by %s', async (mode) => {
    const { service, store, sent, onConfigApplied, onRecoveryFailed } = setup();
    onConfigApplied.mockRejectedValueOnce(new Error('Runtime rejected bindings'));
    const save = vi.mocked(store.save).mockResolvedValueOnce(success(undefined));
    if (mode === 'result') save.mockResolvedValueOnce(failure('ConfigurationError', 'private filesystem details'));
    else save.mockRejectedValueOnce(new Error('private filesystem details'));

    await service.handle(update({ 'controller.host': 'new-controller.test' }));

    expect(service.current).toEqual(makeConfig());
    expect(onRecoveryFailed).toHaveBeenCalledOnce();
    expect(onConfigApplied).toHaveBeenCalledOnce();
    expect(onConfigApplied.mock.calls[0]?.[0].controller.host).toBe('new-controller.test');
    expect(sent[0]).toMatchObject({ type: 'CONFIG_UPDATE_RESPONSE', body: { status: 'FAILED' } });
    expect(sent[0]?.body?.['message']).toContain('nicht sicher wiederhergestellt');
    expect(JSON.stringify(sent)).not.toContain('private');

    await service.handle(update({ 'loadManagement.gridLimitW': 20_000 }, 'after-recovery-failure'));
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(onConfigApplied).toHaveBeenCalledOnce();
    expect(sent[1]?.body?.['status']).toBe('FAILED');
    expect(onRecoveryFailed).toHaveBeenCalledOnce();
  });

  it('fails closed when runtime rollback fails despite restoring the disk configuration', async () => {
    const { service, saved, sent, onConfigApplied, onRecoveryFailed } = setup();
    onConfigApplied.mockRejectedValue(new Error('private runtime failure'));
    await service.handle(update({ 'controller.host': 'new-controller.test' }));
    expect(saved.at(-1)).toEqual(makeConfig());
    expect(service.current).toEqual(makeConfig());
    expect(onRecoveryFailed).toHaveBeenCalledOnce();
    expect(sent[0]?.body?.['message']).toContain('Regelung gesperrt');
    expect(JSON.stringify(sent)).not.toContain('private');
  });

  it('rejects queued updates after recovery failure even if the stop callback rejects', async () => {
    const { service, store, sent, onConfigApplied, onRecoveryFailed } = setup();
    onConfigApplied.mockRejectedValue(new Error('Runtime failure'));
    onRecoveryFailed.mockRejectedValue(new Error('private stop failure'));
    await expect(Promise.all([
      service.handle(update({ 'controller.host': 'new-controller.test' }, 'first')),
      service.handle(update({ 'loadManagement.gridLimitW': 20_000 }, 'queued')),
    ])).resolves.toEqual([true, true]);
    expect(onRecoveryFailed).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(sent.map((message) => message.body?.['status'])).toEqual(['FAILED', 'FAILED']);
    expect(JSON.stringify(sent)).not.toContain('private');
  });

  it('accepts another update after a runtime rejection whose rollback succeeded', async () => {
    const { service, sent, onConfigApplied, onRecoveryFailed } = setup();
    onConfigApplied.mockRejectedValueOnce(new Error('Bindings rejected'));
    await service.handle(update({ 'controller.host': 'rejected.test' }, 'rejected'));
    await service.handle(update({ 'loadManagement.gridLimitW': 20_000 }, 'valid'));
    expect(sent.map((message) => message.body?.['status'])).toEqual(['FAILED', 'APPLIED']);
    expect(service.current.loadManagement.gridLimitW).toBe(20_000);
    expect(onRecoveryFailed).not.toHaveBeenCalled();
  });

  it('serializes concurrent partial updates without losing previously applied changes', async () => {
    const { service, saved } = setup();
    await Promise.all([
      service.handle(update({ 'loadManagement.gridLimitW': 20_000 }, 'one')),
      service.handle(update({ 'loadManagement.safetyReserveW': 750 }, 'two')),
    ]);
    expect(service.current.loadManagement).toMatchObject({ gridLimitW: 20_000, safetyReserveW: 750 });
    expect(saved).toHaveLength(2);
    expect(saved[1]?.loadManagement).toMatchObject({ gridLimitW: 20_000, safetyReserveW: 750 });
  });

  it('allows a successful update after a failed one instead of poisoning the queue', async () => {
    const { service, sent, store } = setup();
    vi.mocked(store.save).mockRejectedValueOnce(new Error('failure'));
    await service.handle(update({ 'controller.host': 'failed.test' }, 'failed'));
    await service.handle(update({ 'controller.host': 'successful.test' }, 'successful'));
    expect(service.current.controller.host).toBe('successful.test');
    expect(sent.map((message) => message.body?.['status'])).toEqual(['FAILED', 'APPLIED']);
  });

  it('makes current snapshots defensive copies', async () => {
    const { service } = setup();
    const current = service.current;
    Object.assign(current.controller, { host: 'mutated.test' });
    expect(service.current.controller.host).toBe('controller.test');
  });

  it('ignores other plugin ids and unrelated message types', async () => {
    const { service, sent } = setup();
    expect(await service.handle({ ...update({}), pluginId: 'unrelated' })).toBe(false);
    expect(await service.handle({ pluginId, id: 'state', type: 'PLUGIN_STATE_REQUEST', body: {} })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('localizes response feedback for documented English requests', async () => {
    const { service, sent } = setup();
    await service.handle(update({ 'loadManagement.gridLimitW': 0 }, 'invalid', 'en'));
    expect(sent[0]?.body?.['message']).toContain('Invalid configuration');
  });
});
