import type { AppConfig } from '../../config/config-types.js';
import { getNotificationSettings } from '../../config/notification-settings.js';
import { validateConfig } from '../../config/config-schema.js';
import { failure, type Result } from '../../domain/errors.js';
import type { RuntimeSnapshot } from '../../orchestration/runtime-snapshot.js';
import type { ConfigUpdateRequest, HcuSender, IncomingHcuMessage } from '../message-types.js';
import { buildConfigTemplate, HCU_CHARGER_SLOTS } from './config-template-builder.js';
import type { ConfigStore } from './config-store.js';

export interface HcuConfigServiceOptions {
  readonly pluginId: string;
  readonly sender: HcuSender;
  readonly store: ConfigStore;
  readonly initialConfig: AppConfig;
  readonly getSnapshot: () => RuntimeSnapshot;
  /** Runtime adapter must atomically swap its configuration before resolving. */
  readonly onConfigApplied: (config: AppConfig) => void | Promise<void>;
  /** Fail closed if disk/runtime rollback cannot restore one coherent configuration. */
  readonly onRecoveryFailed?: () => void | Promise<void>;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('A boolean property must be true or false.');
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('A numeric property must contain a finite decimal number.');
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A text property must be a string.');
  return value;
}

/** Apply only our declared editable properties, then validate the complete model. */
export function applyHcuConfigProperties(
  config: AppConfig,
  properties: Readonly<Record<string, unknown>>,
): Result<AppConfig> {
  let host = config.controller.host;
  const settings = { ...config.loadManagement };
  const chargers = config.chargers.map((charger) => ({ ...charger }));
  const notifications = { ...getNotificationSettings(config) };
  let changedNotifications = false;
  try {
    for (const [id, value] of Object.entries(properties)) {
      switch (id) {
        case 'controller.host': host = stringValue(value); break;
        case 'loadManagement.enabled': settings.enabled = booleanValue(value); break;
        case 'loadManagement.liveControlEnabled': settings.liveControlEnabled = booleanValue(value); break;
        case 'loadManagement.gridLimitW': settings.gridLimitW = numberValue(value); break;
        case 'loadManagement.safetyReserveW': settings.safetyReserveW = numberValue(value); break;
        case 'loadManagement.triggerDurationSeconds': settings.triggerDurationSeconds = numberValue(value); break;
        case 'loadManagement.controlIntervalSeconds': settings.controlIntervalSeconds = numberValue(value); break;
        case 'notifications.intervention': notifications.intervention = booleanValue(value); changedNotifications = true; break;
        case 'notifications.controllerConnectionError': notifications.controllerConnectionError = booleanValue(value); changedNotifications = true; break;
        case 'notifications.chargerConnectionError': notifications.chargerConnectionError = booleanValue(value); changedNotifications = true; break;
        case 'notifications.interactive': notifications.interactive = booleanValue(value); changedNotifications = true; break;
        default: {
          const match = /^chargers\.(garage|links|rechts)\.(enabled|name|host|priority)$/u.exec(id);
          const slot = match?.[1];
          const field = match?.[2];
          if (slot === undefined || !HCU_CHARGER_SLOTS.some((entry) => entry === slot)) {
            return failure('ConfigurationError', 'Unknown or read-only HCU configuration property.');
          }
          const charger = chargers.find((entry) => entry.id === slot);
          if (charger === undefined) return failure('ConfigurationError', 'The requested charger slot is not configured.');
          switch (field) {
            case 'enabled': charger.enabled = booleanValue(value); break;
            case 'name': charger.name = stringValue(value); break;
            case 'host': charger.host = stringValue(value); break;
            case 'priority': charger.priority = numberValue(value); break;
            default: return failure('ConfigurationError', 'Unknown or read-only HCU configuration property.');
          }
        }
      }
    }
  } catch {
    return failure('ConfigurationError', 'HCU configuration properties contain an invalid value type.');
  }
  return validateConfig({ ...config, controller: { host }, loadManagement: settings, chargers,
    ...(changedNotifications ? { notifications } : {}) });
}

/** Serializes complete updates so concurrent requests cannot overwrite each other. */
export class HcuConfigService {
  private config: AppConfig;
  private updateQueue: Promise<void> = Promise.resolve();
  private recoveryFailed = false;

  public constructor(private readonly options: HcuConfigServiceOptions) {
    const validated = validateConfig(options.initialConfig);
    if (!validated.ok) throw new Error('HCU configuration requires validated initial configuration.');
    this.config = validated.value;
  }

  public get current(): AppConfig { return structuredClone(this.config); }

  public async handle(message: IncomingHcuMessage): Promise<boolean> {
    if (message.pluginId !== this.options.pluginId) return false;
    if (message.type === 'CONFIG_TEMPLATE_REQUEST') {
      await this.updateQueue;
      const template = buildConfigTemplate(this.config, this.options.getSnapshot(), message.body.languageCode);
      this.options.sender.send({ pluginId: this.options.pluginId, id: message.id, type: 'CONFIG_TEMPLATE_RESPONSE',
        body: { groups: template.groups, properties: template.properties } });
      return true;
    }
    if (message.type !== 'CONFIG_UPDATE_REQUEST') return false;
    const work = this.updateQueue.then(() => this.update(message));
    // An adapter failure must not permanently poison the update queue.
    this.updateQueue = work.catch(() => undefined);
    await work;
    return true;
  }

  private respond(message: ConfigUpdateRequest, status: 'APPLIED' | 'FAILED', de: string, en: string): void {
    this.options.sender.send({ pluginId: this.options.pluginId, id: message.id, type: 'CONFIG_UPDATE_RESPONSE',
      body: { status, message: message.body.languageCode === 'en' ? en : de } });
  }

  private async update(message: ConfigUpdateRequest): Promise<void> {
    if (this.recoveryFailed) {
      this.respondRecoveryFailure(message);
      return;
    }
    const validated = applyHcuConfigProperties(this.config, message.body.properties ?? {});
    if (!validated.ok) {
      this.respond(message, 'FAILED', 'Konfiguration ungültig. Änderungen vollständig verworfen; Host, Werte und editierbare Felder prüfen.',
        'Invalid configuration. All changes were rejected; check device hosts, values and editable properties.');
      return;
    }
    const previous = this.config;
    try {
      const stored = await this.options.store.save(validated.value);
      if (!stored.ok) {
        this.respond(message, 'FAILED', 'Konfiguration konnte nicht gespeichert werden. Bisheriger Stand bleibt aktiv.',
          'Configuration could not be persisted. The previous configuration remains active.');
        return;
      }
    } catch {
      this.respond(message, 'FAILED', 'Konfiguration konnte nicht gespeichert werden. Bisheriger Stand bleibt aktiv.',
        'Configuration could not be persisted. The previous configuration remains active.');
      return;
    }
    try {
      await this.options.onConfigApplied(structuredClone(validated.value));
    } catch {
      let stored = false;
      try { stored = (await this.options.store.save(previous)).ok; } catch { /* Recovery remains failed. */ }
      if (!stored) {
        // Do not reactivate an old runtime against a disk configuration that could not be restored.
        await this.failRecovery(message);
        return;
      }
      try { await this.options.onConfigApplied(structuredClone(previous)); }
      catch { await this.failRecovery(message); return; }
      this.respond(message, 'FAILED', 'Runtime konnte Konfiguration nicht übernehmen. Bisheriger Stand wurde zur Wiederherstellung beibehalten.',
        'Runtime configuration update failed. The previous configuration was retained for recovery.');
      return;
    }
    this.config = validated.value;
    this.respond(message, 'APPLIED', 'Konfiguration gespeichert und übernommen.', 'Configuration persisted and applied.');
  }

  private respondRecoveryFailure(message: ConfigUpdateRequest): void {
    this.respond(message, 'FAILED',
      'Konfiguration konnte nicht sicher wiederhergestellt werden. Regelung gesperrt; Persistenz prüfen und Plugin neu starten.',
      'Configuration recovery failed. Control is blocked; inspect persistence and restart the plugin.');
  }

  private async failRecovery(message: ConfigUpdateRequest): Promise<void> {
    this.recoveryFailed = true;
    try { await this.options.onRecoveryFailed?.(); } catch { /* Report without native details; updates stay blocked. */ }
    this.respondRecoveryFailure(message);
  }
}
