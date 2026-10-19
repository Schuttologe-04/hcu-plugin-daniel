import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_ID, PLUGIN_VERSION } from '../../../src/hcu/plugin-identity.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const validator = join(root, 'scripts/validate-hcu-image.mjs');
const inputChecker = join(root, 'scripts/check-package-inputs.mjs');
let temporary: string | undefined;
async function directory(): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), 'hcu-package-test-'));
  return temporary;
}
afterEach(async () => {
  if (temporary !== undefined && temporary.startsWith(join(tmpdir(), 'hcu-package-test-'))) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function inspectedImage() {
  return { Id: `sha256:${'a'.repeat(64)}`, Size: 100_000_000, Os: 'linux', Architecture: 'arm64', Config: {
    Entrypoint: ['node', '/app/dist/cli/hcu-installed.js'], Cmd: [], ExposedPorts: {},
    Env: ['NODE_ENV=production', 'NODE_VERSION=24.21.0', 'GOE_REAL_WRITES_ENABLED=true'],
    Labels: { 'de.eq3.hmip.plugin.metadata': JSON.stringify({ pluginId: 'com.psd.hcu.goe.loadmanagement', issuer: 'PSD', version: '0.2.1', hcuMinVersion: '1.4.7', scope: 'LOCAL', logsEnabled: true, friendlyName: { de: 'go-e Lastmanagement' }, description: { de: 'Local go-e charger management' } }) },
  } };
}
async function runValidator(image: unknown): Promise<string> {
  const dir = await directory();
  const file = join(dir, 'inspect.json');
  await writeFile(file, JSON.stringify(image));
  return execFileSync(process.execPath, [validator, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('HCU packaging image validation', () => {
  it('accepts exactly the ARM64 installed image and returns safe package evidence', async () => {
    expect(JSON.parse(await runValidator([inspectedImage()]))).toEqual({ imageId: `sha256:${'a'.repeat(64)}`, sizeBytes: 100_000_000, platform: 'linux/arm64', pluginId: 'com.psd.hcu.goe.loadmanagement', version: '0.2.1' });
  });
  it.each(['amd64', 'arm', 'unknown'])('rejects the %s architecture', async (architecture) => {
    await expect(runValidator([{ ...inspectedImage(), Architecture: architecture }])).rejects.toThrow();
  });
  it('rejects non-Linux images', async () => { await expect(runValidator([{ ...inspectedImage(), Os: 'windows' }])).rejects.toThrow(); });
  it.each([['npm', 'run', 'hcu:dev'], ['node', '/app/dist/cli/hcu-live.js'], ['node', '/app/dist/cli/hcu-dev.js']])('rejects another entrypoint %#', async (...entrypoint) => {
    const image = inspectedImage(); image.Config.Entrypoint = entrypoint;
    await expect(runValidator([image])).rejects.toThrow();
  });
  it('rejects additional commands after installed entrypoint', async () => {
    const image = inspectedImage(); const modified = { ...image, Config: { ...image.Config, Cmd: ['--unsafe'] } };
    await expect(runValidator([modified])).rejects.toThrow();
  });
  it.each(['HCU_AUTHTOKEN=MOCK_SECRET', 'HCU_WS_URL=wss://remote.invalid:9001', 'CLIENTID=MOCK_CLIENT', 'ACTIVATION_KEY=MOCK_KEY', 'NODE_TLS_REJECT_UNAUTHORIZED=0'])('rejects embedded credentials/global TLS %# without exposing their value', async (entry) => {
    const image = inspectedImage(); image.Config.Env.push(entry);
    await expect(runValidator([image])).rejects.toThrow();
  });
  it('requires the distribution capability', async () => {
    const image = inspectedImage(); image.Config.Env = ['NODE_ENV=production'];
    await expect(runValidator([image])).rejects.toThrow();
  });
  it('rejects exposed ports', async () => {
    const image = inspectedImage(); const modified = { ...image, Config: { ...image.Config, ExposedPorts: { '9001/tcp': {} } } };
    await expect(runValidator([modified])).rejects.toThrow();
  });
  it.each([{ pluginId: 'other.plugin' }, { version: '0.1.0' }, { version: '0.2.0' }, { version: '0.3.0' }, { scope: 'CLOUD' }, { logsEnabled: false }, { issuer: 'other' }, { hcuMinVersion: '1.0.0' }])('rejects incompatible metadata %#', async (changed) => {
    const image = inspectedImage(); const original: unknown = JSON.parse(image.Config.Labels['de.eq3.hmip.plugin.metadata']);
    if (typeof original !== 'object' || original === null) throw new Error('invalid test setup');
    image.Config.Labels['de.eq3.hmip.plugin.metadata'] = JSON.stringify({ ...original, ...changed });
    await expect(runValidator([image])).rejects.toThrow();
  });
  it.each([[], {}, [{ ...inspectedImage(), Id: 'untrusted' }], [{ ...inspectedImage(), Size: 0 }]])('rejects invalid inspect evidence %#', async (input) => { await expect(runValidator(input)).rejects.toThrow(); });
});

describe('HCU package context and isolated smoke safety', () => {
  it('keeps version 0.2.1 and the installed identity consistent in manifests, metadata and artifact names', async () => {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const lock: unknown = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
    const script = await readFile(join(root, 'scripts/package-hcu.ps1'), 'utf8');
    const label = dockerfile.match(/^LABEL de\.eq3\.hmip\.plugin\.metadata='([^']+)'\r?$/m)?.[1];
    expect(label).toBeDefined();
    if (label === undefined) throw new Error('Missing release metadata label');
    const metadata: unknown = JSON.parse(label);
    expect(PLUGIN_VERSION).toBe('0.2.1');
    expect(PLUGIN_ID).toBe('com.psd.hcu.goe.loadmanagement');
    expect(manifest).toMatchObject({ version: PLUGIN_VERSION });
    expect(lock).toMatchObject({ version: PLUGIN_VERSION, packages: { '': { version: PLUGIN_VERSION } } });
    expect(metadata).toMatchObject({ pluginId: PLUGIN_ID, version: PLUGIN_VERSION, issuer: 'PSD', hcuMinVersion: '1.4.7', scope: 'LOCAL', logsEnabled: true });
    expect(script).toContain(`$imageTag = '${PLUGIN_ID}:${PLUGIN_VERSION}'`);
    expect(script).toContain(`$archiveName = '${PLUGIN_ID}-${PLUGIN_VERSION}.tar.gz'`);
    expect(script).toContain(`$checksumName = '${PLUGIN_ID}-${PLUGIN_VERSION}.sha256'`);
    expect(script).not.toContain(`${PLUGIN_ID}-0.1.0.tar.gz`);
    expect(script).not.toContain(`${PLUGIN_ID}-0.2.0.tar.gz`);
  });
  it('calculates the known SHA-256 abc vector in PowerShell without running packaging', async () => {
    const dir = await directory();
    const vector = join(dir, 'abc.bin');
    await writeFile(vector, 'abc', 'ascii');
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const command = `$tokens = $null; $errors = $null; `
      + `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(join(root, 'scripts/package-hcu.ps1'))}, [ref]$tokens, [ref]$errors); `
      + `if ($errors.Count -ne 0) { throw 'Invalid packaging script syntax' }; `
      + `$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ArchiveSha256' }, $true); `
      + `if ($null -eq $function) { throw 'Missing SHA-256 function' }; `
      + `$hashOnly = [scriptblock]::Create($function.Extent.Text + '; Get-ArchiveSha256 -Path $args[0]'); `
      + `& $hashOnly ${quote(vector)}`;
    // Extract only the pure checksum function. Dot-sourcing the package script
    // would build/start Docker and is deliberately forbidden in this test.
    const output = execFileSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output.trim()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('admits only reviewed source/build/seed files and excludes all future unknown files', async () => {
    const rules = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    expect(rules[0]).toBe('**');
    expect(rules).not.toContain('!tests/'); expect(rules).not.toContain('!.env'); expect(rules).not.toContain('!data/');
    expect(rules.filter((rule) => rule.startsWith('!'))).toEqual(['!Dockerfile', '!.dockerignore', '!package.json', '!package-lock.json', '!tsconfig.json', '!tsconfig.build.json', '!config.installed.json', '!src/', '!src/**']);
  });
  it('never starts production entrypoint in the container smoke test and requires no network', async () => {
    const script = await readFile(join(root, 'scripts/package-hcu.ps1'), 'utf8');
    expect(script).toContain("'--network', 'none'"); expect(script).toContain("'--entrypoint', 'node'");
    expect(script).toContain("'/validation/container-smoke.mjs'"); expect(script).toContain("'save', '--platform', 'linux/arm64', '--output'");
    expect(script).toContain("'--provenance=false'");
    expect(script).toContain("'linux/arm64'"); expect(script).toContain('GZipStream'); expect(script).toContain('[System.Security.Cryptography.SHA256]::Create()');
    expect(script).toContain('$algorithm.ComputeHash($hashStream)'); expect(script).not.toContain('Get-FileHash');
    expect(script).not.toContain("'hcu:live'"); expect(script).not.toContain("'hcu:installed'");
  });
  it('requires non-null ownership and message persistence and unchanged session identity in the container smoke', async () => {
    const smoke = await readFile(join(root, 'scripts/container-smoke.mjs'), 'utf8');
    expect(smoke).toContain('ownershipState.ok && ownershipState.value !== null');
    expect(smoke).toContain('messageState.ok && messageState.value !== null');
    expect(smoke).toContain('messageState.value.session.sessionId, previousSessionId');
    expect(smoke.indexOf("typeof globalThis.fetch, 'function'")).toBeLessThan(smoke.indexOf('globalThis.fetch = async'));
  });
  it('runs compiled device projection and read-only control checks without additional hardware reads in the container smoke', async () => {
    const smoke = await readFile(join(root, 'scripts/container-smoke.mjs'), 'utf8');
    expect(smoke).toContain("await import('/app/dist/hcu/devices/device-registry.js')");
    expect(smoke).toContain("await import('/app/dist/hcu/devices/device-projection.js')");
    expect(smoke).toContain("await import('/app/dist/hcu/devices/plugin-device-service.js')");
    expect(smoke).toContain("'charger-links'");
    expect(smoke).toContain("device.deviceId === 'charger-rechts'");
    expect(smoke).toContain('deviceMessages.at(-1).body.success, false');
    expect(smoke).toContain("Object.hasOwn(powerFeature(missingPower), 'currentPower')");
    expect(smoke).toContain('mockedStatusReads, 4');
    expect(smoke).toContain('deviceProjection: true');
  });
  it('pins Node 24, separates production dependencies and starts installed mode without exposing a port', async () => {
    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/node:24\.21\.0-alpine3\.24@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/dist/cli/hcu-installed.js"]');
    expect(dockerfile).not.toMatch(/^\s*EXPOSE\b/m); expect(dockerfile).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });
  it('rejects literal secret values in admitted source without scanning private development files', async () => {
    const dir = await directory();
    await mkdir(join(dir, 'src'));
    for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await writeFile(join(dir, name), await readFile(join(root, name)));
    await writeFile(join(dir, 'config.installed.json'), JSON.stringify({ loadManagement: { liveControlEnabled: false } }));
    await writeFile(join(dir, '.env'), 'PRIVATE_FILE_MUST_NOT_BE_READ=true');
    await writeFile(join(dir, 'src', 'module.ts'), "const authToken = 'MOCK_ASSIGNED_SECRET';");
    expect(() => execFileSync(process.execPath, [inputChecker, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
    await writeFile(join(dir, 'src', 'module.ts'), 'const assigned = { "authToken": "MOCK_JSON_SECRET" };');
    expect(() => execFileSync(process.execPath, [inputChecker, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
    await writeFile(join(dir, 'src', 'module.ts'), 'export const safe = true;');
    const output = execFileSync(process.execPath, [inputChecker, dir], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ status: 'PACKAGE_INPUTS_CHECKED', privateDevelopmentFilesRead: false });
  });
  it('rejects automatically enabled seed configurations', async () => {
    const dir = await directory(); await mkdir(join(dir, 'src'));
    for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await writeFile(join(dir, name), await readFile(join(root, name)));
    await writeFile(join(dir, 'config.installed.json'), JSON.stringify({ loadManagement: { liveControlEnabled: true } }));
    expect(() => execFileSync(process.execPath, [inputChecker, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
  });
});
