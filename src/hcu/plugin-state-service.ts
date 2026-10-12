import { RandomIdProvider, type IdProvider } from './id-provider.js';
import { decodeHcuMessage } from './message-codec.js';
import type { HcuSender } from './message-types.js';

/** Plugin-state business messages remain separate from WebSocket transport. */
export class PluginStateService {
  constructor(readonly sender: HcuSender, readonly idProvider: IdProvider = new RandomIdProvider(), readonly productive = false) {}

  handle(input: unknown): boolean {
    const decoded = decodeHcuMessage(input);
    if (!decoded.ok || decoded.value.kind !== 'known') return false;
    const message = decoded.value.message;
    if (message.type !== 'PLUGIN_STATE_REQUEST' || message.pluginId !== this.sender.pluginId) return false;
    return this.#report(message.id);
  }

  /** The API asks for proactive readiness after startup/reconnect as well as request replies. */
  reportReady(): boolean {
    return this.#report(this.idProvider.nextId());
  }

  #report(id: string): boolean {
    return this.sender.send({
      id,
      pluginId: this.sender.pluginId,
      type: 'PLUGIN_STATE_RESPONSE',
      body: {
        pluginReadinessStatus: 'READY',
        friendlyName: this.productive ? { de: 'go-e Lastmanagement', en: 'go-e load management' }
          : { de: 'go-e Lastmanagement (Dry-Run)', en: 'go-e load management (Dry-Run)' },
      },
    });
  }
}
