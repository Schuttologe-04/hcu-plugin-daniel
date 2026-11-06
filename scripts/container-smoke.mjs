import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// This test is mounted externally and runs with Docker --network none. It never
// starts the production entrypoint or any real HCU/go-e connection.
let networkAttempts = 0;
assert.equal(typeof globalThis.fetch, 'function', 'Native Node fetch must be available before installing the mock.');
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Network forbidden in container smoke test.'); };
const allowed = new Set(['dist', 'node_modules', 'package.json', 'package-lock.json', 'config.installed.json']);
for (const entry of await readdir('/app')) assert(allowed.has(entry), 'Unexpected project file in runtime image.');
const bannedDependencies = ['vitest', 'typescript', '@types/node', '@types/ws', '@vitest', '@typescript'];
for (const name of bannedDependencies) {
  await assert.rejects(readdir(`/app/node_modules/${name}`), 'Development tooling must be absent from runtime.');
}
async function scan(path, inspectText, allowSymlinks = false) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name);
    assert(!/^\.env(?:\.|$)/.test(entry.name), 'Environment files must be absent from runtime.');
    assert(!['TOKEN', 'CLIENTID', 'SGTIN'].includes(entry.name), 'Runtime credentials must not be in the image.');
    assert(!entry.name.endsWith('.node'), 'Unexpected native application dependency in image.');
    if (entry.isSymbolicLink()) { assert(allowSymlinks, 'Unexpected project symlink in image.'); continue; }
    if (entry.isDirectory()) await scan(item, inspectText, allowSymlinks);
    else if (inspectText && /\.(?:js|json|map)$/.test(entry.name)) {
      const value = await readFile(item, 'utf8');
      assert(!/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)|(?:\b(?:authToken|authtoken|HCU_AUTHTOKEN|activationKey|clientId|token)['"]?\s*[:=]\s*['"][^'"\r\n]+['"])/i.test(value), 'Literal credential/private key in project runtime.');
    }
  }
}
await scan('/app/dist', true);
await scan('/app/node_modules', false, true);
const { InstalledHcuEnvironment } = await import('/app/dist/hcu/runtime/installed-environment.js');
const { validateConfig } = await import('/app/dist/config/config-schema.js');
const { FileConfigStore } = await import('/app/dist/hcu/config/config-store.js');
const { FileOwnershipStore } = await import('/app/dist/goe/control/ownership-store.js');
const { runHcuInstalledCli } = await import('/app/dist/cli/hcu-installed.js');
const environment = await new InstalledHcuEnvironment().resolve();
assert(environment.ok, 'Mounted installed runtime files must resolve.');
assert.equal(environment.value.url, 'wss://host.containers.internal:9001');
assert.equal(environment.value.dataDirectory, '/data');
assert.equal(environment.value.pluginId, 'com.psd.hcu.goe.loadmanagement');
assert.equal(environment.value.authtoken, 'MOCK_CONTAINER_TOKEN');
assert.equal(environment.value.clientId, 'MOCK_CONTAINER_CLIENT');
assert.equal(environment.value.sgtin, 'MOCK_CONTAINER_SGTIN');
assert.equal(process.arch, 'arm64');
assert.equal(process.platform, 'linux');
assert.equal(process.versions.node, '24.21.0');
assert.equal(process.env.GOE_REAL_WRITES_ENABLED, 'true');
assert.equal(typeof AbortController, 'function');
const seed = validateConfig(JSON.parse(await readFile('/app/config.installed.json', 'utf8')));
assert(seed.ok, 'Seed config must validate.');
assert.equal(seed.value.loadManagement.liveControlEnabled, false);
assert.equal(seed.value.chargers.find((charger) => charger.id === 'rechts')?.enabled, false);
const configStore = new FileConfigStore('/data');
assert.deepEqual(await configStore.load(), { ok: true, value: null });
assert.equal((await configStore.save(seed.value)).ok, true);
assert.deepEqual(await new FileConfigStore('/data').load(), { ok: true, value: seed.value });
const ownership = new FileOwnershipStore('/data');
assert.deepEqual(await ownership.load(), { ok: true, value: null });
assert.equal((await ownership.save({ version: 1, chargers: [] })).ok, true);
assert.deepEqual(await new FileOwnershipStore('/data').load(), { ok: true, value: { version: 1, chargers: [] } });

// Exercise the actual installed entrypoint twice with filesystem mounts and
// injected protocol/device boundaries. All status reads remain in memory.
const { HcuWebSocketClient } = await import('/app/dist/hcu/websocket-client.js');
const { ChargerActuator } = await import('/app/dist/goe/control/charger-actuator.js');
const { FileInteractionStateStore } = await import('/app/dist/hcu/messages/interaction-state-store.js');
const { default: pino } = await import('/app/node_modules/pino/pino.js');
let mockedStatusReads = 0;
let attemptedWrites = 0;
class MockSocket extends EventEmitter {
  readyState = 0;
  send(text) {
    const request = JSON.parse(text);
    if (request.type === 'LIST_USER_MESSAGES_REQUEST') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: request.id, pluginId: request.pluginId,
        type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: {} } })));
    }
  }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}
const entryDirectory = '/data/entry-test';
let previousConfig;
let previousSessionId;
for (let restart = 0; restart < 2; restart += 1) {
  let application;
  let stopped;
  let socket;
  const result = await runHcuInstalledCli([], {
    environment: { resolve: async () => ({ ok: true, value: { ...environment.value, dataDirectory: entryDirectory } }) },
    logger: pino({ enabled: false }), registerSignals: false,
    clientFactory: (settings) => new HcuWebSocketClient({ ...settings, webSocketFactory: () => { socket = new MockSocket(); return socket; } }),
    actuatorFactory: (_config, directory, gate, now) => new ChargerActuator({ gate, now, store: new FileOwnershipStore(directory), client: {
      readStatus: async (charger) => { mockedStatusReads += 1; const timestamp = now(); return { ok: true, value: {
        chargerId: charger.id, host: charger.host, readStartedAtMs: timestamp, observedAtMs: timestamp,
        amp: 14, tcl: null, frc: 0, loe: false, car: charger.id === 'garage' ? 2 : 1,
        mca: 6, acu: 14, ama: 16, acp: true, mcpd: 0, alw: true,
        firmwareVersion: '59.4', tclClearCapability: 'VERIFIED',
      } }; },
      setTemporaryCurrentLimit: async () => { attemptedWrites += 1; throw new Error('Write forbidden in smoke.'); },
      clearTemporaryCurrentLimit: async () => { attemptedWrites += 1; throw new Error('Write forbidden in smoke.'); },
      pause: async () => { attemptedWrites += 1; throw new Error('Write forbidden in smoke.'); },
      resume: async () => { attemptedWrites += 1; throw new Error('Write forbidden in smoke.'); },
    } }),
    onStarted: (app) => {
      application = app;
      assert.equal(app.snapshot.mode, 'INSTALLED_LIVE');
      assert.equal(app.snapshot.automaticLiveControlEnabled, false);
      assert(socket, 'Mock installed socket must have been created.');
      socket.readyState = 1; socket.emit('open');
      stopped = app.stop();
    },
  });
  assert.equal(result, 0, 'Installed entry must initialize without existing state.');
  assert(application, 'Installed entry must start the composed HCU service.');
  await stopped;
  const configText = await readFile(`${entryDirectory}/plugin-config.json`, 'utf8');
  if (previousConfig !== undefined) assert.equal(configText, previousConfig, 'Restart must not overwrite persistent config.');
  previousConfig = configText;
  const ownershipState = await new FileOwnershipStore(entryDirectory).load();
  assert(ownershipState.ok && ownershipState.value !== null, 'Installed entry must persist actual ownership evidence.');
  assert.equal(ownershipState.value.version, 1);
  assert.deepEqual(ownershipState.value.chargers.map((state) => state.chargerId).sort(), ['garage', 'links']);
  const messageState = await new FileInteractionStateStore(entryDirectory).load();
  assert(messageState.ok && messageState.value !== null, 'Installed entry must persist actual message/session evidence.');
  assert.equal(messageState.value.version, 1);
  assert.equal(messageState.value.pluginId, 'com.psd.hcu.goe.loadmanagement');
  assert.equal(messageState.value.session.overrideActive, false);
  if (previousSessionId !== undefined) assert.equal(messageState.value.session.sessionId, previousSessionId, 'Restart must retain the persisted HCU session identity.');
  previousSessionId = messageState.value.session.sessionId;
}

// The new HmIP devices are a pure projection of already decoded telemetry.
// Exercise the compiled release modules without another device poll, actuator
// reference or live socket; the global fetch fence remains active throughout.
const { createDeviceRegistry } = await import('/app/dist/hcu/devices/device-registry.js');
const { projectDevice } = await import('/app/dist/hcu/devices/device-projection.js');
const { PluginDeviceService } = await import('/app/dist/hcu/devices/plugin-device-service.js');
const { mapControllerStatus } = await import('/app/dist/goe/controller-mapper.js');
const { mapChargerStatus } = await import('/app/dist/goe/charger-mapper.js');
const registry = createDeviceRegistry(seed.value);
const expectedDeviceIds = ['controller-grid', 'controller-home', 'controller-solar', 'charger-garage', 'charger-links'];
assert.deepEqual(registry.map(device => device.deviceId), expectedDeviceIds);
assert.deepEqual(registry.map(device => device.deviceType), ['GRID_CONNECTION_POINT', 'ENERGY_METER', 'INVERTER', 'EV_CHARGER', 'EV_CHARGER']);
assert(!registry.some(device => device.deviceId === 'charger-rechts'), 'Disabled Rechts must never be discoverable.');
const controller = mapControllerStatus({
  ccn: ['Solar', 'Grid', 'Home'], ccp: [-5000, -1000.4, 4000.2],
  cpc: [[null, null, null], [1, 2, 3], [null, null, null]],
}, seed.value.controller.host);
assert(controller.ok, 'Compiled controller mapper must preserve the valid Grid snapshot.');
const chargerReadings = seed.value.chargers.map(config => {
  if (!config.enabled) return { status: 'disabled', reachable: false, config };
  const power = config.id === 'garage' ? 1000 : 0;
  const mapped = mapChargerStatus({
    fna: config.name, fwv: '59.4', car: config.id === 'garage' ? 2 : 1,
    amp: 14, acu: 14, ama: 16, tcl: null, alw: true, frc: 0,
    mca: 6, acp: true, mcpd: 0, modelStatus: 15,
    nrg: [...Array(11).fill(null), power],
  }, config);
  assert(mapped.ok, 'Compiled charger mapper must decode nrg[11].');
  return { status: 'reachable', reachable: true, config, value: mapped.value };
});
const report = { controller, chargers: chargerReadings };
const projected = registry.map(definition => projectDevice(definition, report));
const powerFeature = device => device.features.find(feature => feature.type === 'currentPower');
assert.equal(powerFeature(projected[0]).currentPower, -1000, 'Grid export must retain its signed value.');
assert.equal(powerFeature(projected[1]).currentPower, 4000);
assert.equal(powerFeature(projected[2]).currentPower, 5000, 'Solar projection must invert the raw sign.');
assert.equal(powerFeature(projected[3]).currentPower, 1000);
assert.equal(powerFeature(projected[4]).currentPower, 0, 'A genuine nrg[11] zero is a valid measurement.');
const missingPowerReport = { ...report, chargers: chargerReadings.map(charger => charger.status === 'reachable'
  ? { ...charger, value: { ...charger.value, currentPowerW: null, rawNrg: null } } : charger) };
const missingPower = projectDevice(registry[3], missingPowerReport);
assert(!Object.hasOwn(powerFeature(missingPower), 'currentPower'), 'Missing power must be omitted, never manufactured as zero.');
assert.equal(missingPower.features.find(feature => feature.type === 'maintenance').unreach, false);
const positiveSolarReport = { ...report, controller: { ok: true, value: { ...controller.value, solarPowerW: 500 } } };
assert.equal(powerFeature(projectDevice(registry[2], positiveSolarReport)).currentPower, -500, 'Solar inversion must not use an absolute value.');
const deviceMessages = [];
let deviceMessageId = 0;
let deviceNow = 0;
const devices = new PluginDeviceService({ config: seed.value,
  sender: { pluginId: environment.value.pluginId, send: message => { deviceMessages.push(message); return true; } },
  idProvider: { nextId: () => `MOCK_DEVICE_MESSAGE_${deviceMessageId += 1}` },
  now: () => deviceNow,
});
devices.setConnectionState('READY');
devices.observe(report, { sampledAtMs: deviceNow, receivedAtMs: deviceNow });
assert.equal(deviceMessages.length, 0, 'Unknown inclusion state must not publish speculative events.');
devices.handle({ pluginId: environment.value.pluginId, id: 'MOCK_DISCOVERY', type: 'DISCOVER_REQUEST', body: {} });
assert.equal(deviceMessages.at(-1).type, 'DISCOVER_RESPONSE');
assert.deepEqual(deviceMessages.at(-1).body.devices.map(device => device.deviceId), expectedDeviceIds);
assert(deviceMessages.at(-1).body.devices.every(device => !Object.hasOwn(powerFeature(device), 'currentPower')), 'Discovery must not bypass the first minute with raw telemetry.');
devices.handle({ pluginId: environment.value.pluginId, id: 'MOCK_INCLUSION', type: 'INCLUSION_EVENT', body: { deviceIds: ['controller-grid', 'charger-garage'] } });
assert.equal(deviceMessages.at(-1).type, 'STATUS_RESPONSE');
const beforeRepeatedMeasurement = deviceMessages.length;
devices.observe(report, { sampledAtMs: deviceNow, receivedAtMs: deviceNow });
assert.equal(deviceMessages.length, beforeRepeatedMeasurement, 'Equal projected measurements must be deduplicated.');
const changedReport = { ...report, chargers: chargerReadings.map(charger => charger.status === 'reachable' && charger.config.id === 'garage'
  ? { ...charger, value: { ...charger.value, currentPowerW: 1500 } } : charger) };
for (deviceNow = 2_000; deviceNow < 60_000; deviceNow += 2_000) {
  devices.observe(changedReport, { sampledAtMs: deviceNow, receivedAtMs: deviceNow });
  assert.equal(deviceMessages.length, beforeRepeatedMeasurement, 'Fast samples must not publish raw power within a minute.');
}
devices.observe(changedReport, { sampledAtMs: deviceNow, receivedAtMs: deviceNow });
assert.equal(deviceMessages.at(-1).type, 'STATUS_EVENT');
assert.deepEqual(deviceMessages.at(-1).body, { deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower: 1483 }] }, 'Minute mean must weight the first two seconds at 1000 W and the remaining 58 seconds at 1500 W.');
devices.handle({ pluginId: environment.value.pluginId, id: 'MOCK_CACHED_MINUTE', type: 'STATUS_REQUEST', body: { deviceIds: ['charger-garage'] } });
assert.equal(powerFeature(deviceMessages.at(-1).body.devices[0]).currentPower, 1483, 'Explicit status must return the completed minute, not the latest 1500 W sample.');
for (const deviceId of expectedDeviceIds) {
  const requestId = `MOCK_CONTROL_${deviceId}`;
  devices.handle({ pluginId: environment.value.pluginId, id: requestId, type: 'CONTROL_REQUEST', body: {
    deviceId, features: [{ type: 'currentPower', currentPower: 0 }],
  } });
  assert.equal(deviceMessages.at(-1).type, 'CONTROL_RESPONSE');
  assert.equal(deviceMessages.at(-1).id, requestId);
  assert.equal(deviceMessages.at(-1).body.success, false, 'Every sensor device must reject control.');
}
assert.equal(networkAttempts, 0, 'Imports/persistence must not contact any device.');
assert.equal(attemptedWrites, 0, 'Default-disabled installed mode must not request a control write.');
assert.equal(mockedStatusReads, 4, 'Both reachable chargers must be read on first start and restart.');
console.log(JSON.stringify({ status: 'CONTAINER_MOCK_SMOKE_PASSED', platform: 'linux/arm64', nodeVersion: process.versions.node, mountedRuntimeFiles: true, installedEntrypoint: true, configRestart: true, ownershipRestart: true, messageRestart: true, deviceProjection: true, minutePowerPublishing: true, discoveredDevices: expectedDeviceIds.length, readOnlyDeviceControl: true, mockedStatusReads, networkAttempts, realHardwareWrites: 0 }));
