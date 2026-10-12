import { describe, expect, it, vi } from 'vitest';
import { PluginStateService } from '../../../src/hcu/plugin-state-service.js';
import type { HcuEnvelope, HcuSender } from '../../../src/hcu/message-types.js';
import { SequenceIds } from './transport-helpers.js';

function service(): { service: PluginStateService; send: ReturnType<typeof vi.fn<(message: HcuEnvelope) => boolean>> } {
  const send = vi.fn<(message: HcuEnvelope) => boolean>().mockReturnValue(true);
  const sender: HcuSender = { pluginId: 'plugin', send };
  return { service: new PluginStateService(sender, new SequenceIds()), send };
}

describe('PluginStateService', () => {
  it('responds READY with the request correlation id and localized plugin name', () => {
    const { service: state, send } = service();
    expect(state.handle({ pluginId: 'plugin', id: 'same-id', type: 'PLUGIN_STATE_REQUEST', body: {} })).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      pluginId: 'plugin', id: 'same-id', type: 'PLUGIN_STATE_RESPONSE',
      body: { pluginReadinessStatus: 'READY', friendlyName: { de: 'go-e Lastmanagement (Dry-Run)', en: 'go-e load management (Dry-Run)' } },
    });
  });

  it('accepts an omitted body because the documented envelope allows it', () => {
    const { service: state, send } = service();
    expect(state.handle({ pluginId: 'plugin', id: 'request', type: 'PLUGIN_STATE_REQUEST' })).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('uses an injected identifier for proactive readiness after startup/reconnect', () => {
    const { service: state, send } = service();
    expect(state.reportReady()).toBe(true);
    expect(state.reportReady()).toBe(true);
    expect(send.mock.calls.map(([message]) => message.id)).toEqual(['request-1', 'request-2']);
  });

  it.each([null, {}, { pluginId: 'plugin', type: 'PLUGIN_STATE_REQUEST', body: {} },
    { pluginId: 'plugin', id: '', type: 'PLUGIN_STATE_REQUEST', body: {} },
    { pluginId: 'plugin', id: 'id', type: 'PLUGIN_STATE_REQUEST', body: [] },
    { pluginId: 'other', id: 'id', type: 'PLUGIN_STATE_REQUEST', body: {} },
    { pluginId: 'plugin', id: 'id', type: 'CONFIG_TEMPLATE_REQUEST', body: {} },
  ])('does not respond to a malformed or unrelated request %#', (request) => {
    const { service: state, send } = service();
    expect(state.handle(request)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates unavailable sender status without pretending READY was sent', () => {
    const { service: state, send } = service();
    send.mockReturnValue(false);
    expect(state.reportReady()).toBe(false);
  });
});
