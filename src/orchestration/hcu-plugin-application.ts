import type { Logger } from 'pino';
import type { AppConfig } from '../config/config-types.js';
import type { ProbeReport } from '../diagnostics/probe-service.js';
import { success, type Result } from '../domain/errors.js';
import type { IdProvider } from '../hcu/id-provider.js';
import type { ConfigStore } from '../hcu/config/config-store.js';
import { HcuConfigService } from '../hcu/config/hcu-config-service.js';
import { HcuUserMessageService } from '../hcu/messages/user-message-service.js';
import { OverrideInteractionCoordinator } from '../hcu/messages/acknowledgement-router.js';
import { PluginStateService } from '../hcu/plugin-state-service.js';
import { PLUGIN_ID } from '../hcu/plugin-identity.js';
import { PluginDeviceService } from '../hcu/devices/plugin-device-service.js';
import type { HcuWebSocketClient } from '../hcu/websocket-client.js';
import type { ChargerActuator } from '../goe/control/charger-actuator.js';
import { DryRunRuntime } from './dry-run-runtime.js';
import { LiveRuntime } from './live-runtime.js';
import { InstalledRuntime } from './installed-runtime.js';
import type { InteractionStateStore } from '../hcu/messages/interaction-state.js';
import { initialRuntimeSnapshot, type RuntimeSnapshot } from './runtime-snapshot.js';

export interface HcuPluginApplicationOptions {
  readonly client: HcuWebSocketClient;
  readonly store: ConfigStore;
  readonly config: AppConfig;
  readonly mode: RuntimeSnapshot['mode'];
  readonly now: () => number;
  readonly idProvider: IdProvider;
  readonly logger?: Logger;
  readonly probe?: (config: AppConfig) => Promise<ProbeReport>;
  /** This opt-in is used only by the separate hcu:test-message command. */
  readonly sendTestMessage?: boolean;
  readonly liveActuator?: ChargerActuator;
  readonly realWritesEnabled?: boolean;
  readonly interactionStore?: InteractionStateStore;
}

/** Composes HCU services; transport never imports this HCU/engine business logic. */
export class HcuPluginApplication {
  readonly configService: HcuConfigService;
  readonly messages: HcuUserMessageService;
  readonly interactions: OverrideInteractionCoordinator;
  readonly dryRun: DryRunRuntime | null;
  readonly live: LiveRuntime | null;
  readonly installed: InstalledRuntime | null;
  readonly devices: PluginDeviceService;
  readonly #pluginState: PluginStateService;
  #devSnapshot = initialRuntimeSnapshot();
  #running = false;
  #testMessageRequested = false;
  #lastHcuMessage: string | null = null;
  #unsubscribe: (() => void)[] = [];
  #lastMessageReconcileAt: number | null = null;
  #reconcilingMessages = false;

  constructor(private readonly options: HcuPluginApplicationOptions) {
    if (options.mode === 'INSTALLED_LIVE' && options.client.pluginId !== PLUGIN_ID) throw new Error('Installed plugin identity mismatch.');
    if ((options.mode === 'LIVE' || options.mode === 'INSTALLED_LIVE') && (options.liveActuator === undefined || options.realWritesEnabled !== true || options.sendTestMessage)) {
      throw new Error('WRITE_BLOCKED: explicit LIVE gate and actuator are required.');
    }
    const client = options.client;
    this.devices = new PluginDeviceService({ config: options.config, sender: client, idProvider: options.idProvider,
      ...(options.logger === undefined ? {} : { logger: options.logger }) });
    this.#pluginState = new PluginStateService(client, options.idProvider, options.mode === 'INSTALLED_LIVE');
    this.messages = new HcuUserMessageService(client, options.idProvider, options.now);
    this.interactions = new OverrideInteractionCoordinator({
      messages: this.messages, idProvider: options.idProvider,
      onYes: () => {
        this.dryRun?.applyManualOverride();
        this.live?.applyManualOverride();
        this.installed?.applyManualOverride();
        options.logger?.info({ mode: options.mode, realChargerWritesEnabled: options.mode === 'LIVE' || options.mode === 'INSTALLED_LIVE' }, 'HCU answer YES accepted');
      },
      messageMode: options.mode === 'INSTALLED_LIVE' ? 'INSTALLED_LIVE' : options.mode === 'LIVE' ? 'LIVE' : 'DRY_RUN',
      ...(options.interactionStore === undefined ? {} : { stateStore: options.interactionStore, now: options.now }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.dryRun = options.mode === 'DRY_RUN' ? new DryRunRuntime({
      config: options.config, now: options.now, idProvider: options.idProvider,
      onIntervention: () => this.#requestTestIntervention(),
      onEndSession: () => this.interactions.endSession(),
      getInteractionStatus: () => ({ lastMessage: this.#lastHcuMessage, lastAnswer: this.interactions.lastAnswer }),
      onConnectionWarning: async (kind) => {
        this.#lastHcuMessage = `TEST: go-e Verbindungswarnung (${kind})`;
        await this.messages.create({
          title: { de: 'TEST: go-e Verbindungswarnung' },
          message: { de: `Dry-Run: ${kind === 'controller' ? 'Der Controller' : 'Ein Charger'} ist nicht verfügbar. Es wurden keine Einstellungen an den Wallboxen verändert.` },
          behaviorType: 'DISMISSIBLE', messageCategory: 'WARN',
        });
      },
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }) : null;
    this.live = options.mode === 'LIVE' && options.liveActuator !== undefined ? new LiveRuntime({
      config: options.config, gate: { executionMode: 'LIVE', realWritesEnabled: options.realWritesEnabled === true },
      actuator: options.liveActuator, now: options.now, idProvider: options.idProvider,
      onIntervention: () => this.#requestTestIntervention(),
      onEndSession: () => this.interactions.endSession(),
      getInteractionStatus: () => ({ lastMessage: this.#lastHcuMessage, lastAnswer: this.interactions.lastAnswer }),
      onWarning: async (reason) => {
        this.#lastHcuMessage = `go-e Lastmanagement (${reason})`;
        await this.messages.create({ title: { de: 'go-e Lastmanagement – Warnung' },
          message: { de: reason === 'LIMIT_UNACHIEVABLE'
            ? 'Das Regelziel ist mit den aktuell verfügbaren Ladestationen nicht erreichbar.'
            : 'Gültige Telemetrie oder eine sichere Regelentscheidung ist nicht verfügbar. Plugin-eigene Einschränkungen bleiben erhalten.' },
          behaviorType: 'DISMISSIBLE', messageCategory: 'WARN' });
      },
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    }) : null;
    this.installed = options.mode === 'INSTALLED_LIVE' && options.liveActuator !== undefined ? new InstalledRuntime({
      config: options.config, gate: { executionMode: 'LIVE', realWritesEnabled: options.realWritesEnabled === true },
      actuator: options.liveActuator, now: options.now, idProvider: options.idProvider,
      onIntervention: () => {
        this.#observeInstalledMessage(this.#requestTestIntervention());
        return Promise.resolve(success(undefined));
      },
      onEndSession: () => this.interactions.endSession(),
      getInteractionStatus: () => ({ lastMessage: this.#lastHcuMessage, lastAnswer: this.interactions.lastAnswer }),
      onSnapshot: (snapshot) => {
        this.#observeDevices(snapshot.probe);
        if (client.state === 'READY' || client.state === 'CONNECTED') this.#reconcileInstalledMessages(false);
      },
      onError: () => options.logger?.warn('Installed polling cycle failed; existing restrictions remain protected'),
      onWarning: async (reason) => {
        this.#lastHcuMessage = `go-e Lastmanagement (${reason})`;
        this.#observeInstalledMessage(this.messages.create({ title: { de: 'go-e Lastmanagement – Warnung' },
          message: { de: reason === 'LIMIT_UNACHIEVABLE'
            ? 'Das Regelziel ist mit den verfügbaren Ladestationen nicht erreichbar.'
            : 'Sichere Telemetrie oder eine bestätigte Regelentscheidung ist nicht verfügbar. Bestehende eigene Einschränkungen bleiben erhalten.' },
          behaviorType: 'DISMISSIBLE', messageCategory: 'WARN' }));
      },
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    }) : null;
    this.configService = new HcuConfigService({
      pluginId: client.pluginId, sender: client, store: options.store, initialConfig: options.config,
      getSnapshot: () => this.snapshot,
      onConfigApplied: async (config) => {
        if (this.dryRun !== null) await this.dryRun.reconfigure(config);
        else if (this.live !== null) await this.live.reconfigure(config);
        else if (this.installed !== null) await this.installed.reconfigure(config);
        else await this.interactions.endSession();
        try { this.devices.configure(config); }
        catch { options.logger?.warn('Plugin device configuration could not be projected'); }
      },
    });
  }

  get snapshot(): RuntimeSnapshot {
    const snapshot = this.installed?.snapshot ?? this.live?.snapshot ?? this.dryRun?.snapshot ?? {
      ...this.#devSnapshot,
      lastHcuMessage: this.#lastHcuMessage, lastHcuAnswer: this.interactions.lastAnswer,
    };
    return this.installed === null ? snapshot : { ...snapshot,
      openInterventionMessage: this.interactions.openUserMessageId,
      messageStatePersistenceError: this.interactions.persistenceError,
      lastHcuMessage: this.#lastHcuMessage ?? this.interactions.lastMessage };
  }

  async initialize(): Promise<Result<void>> {
    if (this.installed === null) return success(undefined);
    const initialized = await this.installed.initialize();
    if (!initialized.ok) return initialized;
    return this.interactions.initialize({ reconcile: false });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = [
      this.options.client.onMessage(async (message) => {
        if (!this.#running) return;
        if (this.#pluginState.handle(message)) return;
        if (this.devices.handle(message)) return;
        if (await this.configService.handle(message)) return;
        await this.interactions.handleAcknowledgement(message);
      }),
      this.options.client.onState((state) => {
        this.devices.setConnectionState(state);
        this.#devSnapshot = { ...this.#devSnapshot, connectionState: state };
        this.dryRun?.setConnectionState(state);
        this.live?.setConnectionState(state);
        this.installed?.setConnectionState(state);
        if (state !== 'CONNECTED' || !this.#running) return;
        if (this.#pluginState.reportReady()) this.options.client.markReady();
        if (this.installed !== null) this.#reconcileInstalledMessages(true);
        else void this.interactions.reconcile().catch(() => this.options.logger?.warn('HCU test interaction reconciliation failed'));
        if (this.options.sendTestMessage && !this.#testMessageRequested) {
          this.#testMessageRequested = true;
          void this.#requestTestIntervention().catch(() => this.options.logger?.warn('Explicit HCU test message could not be created'));
        }
      }),
    ];
    this.options.client.start();
    // This branch is the only continuous go-e polling start in the application.
    this.dryRun?.start();
    this.installed?.start();
  }

  async endSession(): Promise<void> {
    if (this.dryRun !== null) await this.dryRun.endSession();
    else if (this.live !== null) await this.live.endSession();
    else if (this.installed !== null) await this.installed.endSession();
    else await this.interactions.endSession();
  }

  #requestTestIntervention(): Promise<Result<void>> {
    const pending = this.interactions.requestIntervention();
    this.#lastHcuMessage = this.interactions.lastMessage;
    return pending;
  }

  #observeDevices(report: ProbeReport | null): void {
    try { this.devices.observe(report); }
    catch { this.options.logger?.warn('Plugin device snapshot could not be published'); }
  }

  #observeInstalledMessage(pending: Promise<Result<unknown>>): void {
    // HCU delivery must not delay fresh local telemetry. Only an explicit ACK
    // handled by the coordinator can grant an override; queuing grants none.
    void pending.then((result) => {
      if (!result.ok) this.options.logger?.warn({ errorCode: result.error.code }, 'Installed HCU message could not be delivered');
    }, () => this.options.logger?.warn('Installed HCU message could not be delivered'));
  }

  #reconcileInstalledMessages(force: boolean): void {
    const now = this.options.now();
    if (!this.#running || this.#reconcilingMessages || (!force && this.#lastMessageReconcileAt !== null
      && now - this.#lastMessageReconcileAt < 60_000)) return;
    this.#lastMessageReconcileAt = now;
    this.#reconcilingMessages = true;
    void this.interactions.reconcile().then((result) => {
      if (!result.ok) this.options.logger?.warn({ errorCode: result.error.code }, 'HCU message reconciliation will be retried');
    }, () => this.options.logger?.warn('HCU message reconciliation will be retried'))
      .finally(() => { this.#reconcilingMessages = false; });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.devices.setConnectionState('STOPPED');
    const messagesShutdown = this.interactions.shutdown();
    this.#unsubscribe.forEach((unsubscribe) => unsubscribe());
    this.#unsubscribe = [];
    const installedShutdown = this.installed?.stop();
    // Failing pending HCU requests first prevents shutdown waiting on an offline HCU.
    this.options.client.stop();
    await this.dryRun?.stop();
    const liveShutdown = await this.live?.stop();
    if (liveShutdown !== undefined && !liveShutdown.ok) {
      this.options.logger?.error({ errorCode: liveShutdown.error.code }, 'LIVE ownership persistence failed at shutdown');
      throw new Error('LIVE ownership persistence failed at shutdown.');
    }
    const installedResult = await installedShutdown;
    const messagesResult = await messagesShutdown;
    if (installedResult !== undefined && !installedResult.ok || !messagesResult.ok) {
      this.options.logger?.error('Installed plugin state could not be persisted at shutdown');
      throw new Error('Installed plugin persistence failed at shutdown.');
    }
  }
}
