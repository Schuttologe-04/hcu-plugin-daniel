import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Validate docker image inspect output without ever starting the image. */
export function validateHcuImage(input) {
  if (!Array.isArray(input) || input.length !== 1) throw new Error('Expected one inspected image.');
  const image = input[0];
  if (image?.Os !== 'linux' || image?.Architecture !== 'arm64') throw new Error('HCU image must be linux/arm64.');
  if (typeof image.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Invalid image identity.');
  if (!Number.isSafeInteger(image.Size) || image.Size <= 0) throw new Error('Invalid image size.');
  const config = image.Config;
  if (JSON.stringify(config?.Entrypoint) !== JSON.stringify(['node', '/app/dist/cli/hcu-installed.js'])) {
    throw new Error('Image must start the dedicated installed entrypoint.');
  }
  if (config?.Cmd !== null && config?.Cmd !== undefined && config.Cmd.length !== 0) throw new Error('Unexpected image command.');
  if (Object.keys(config?.ExposedPorts ?? {}).length > 0) throw new Error('Plugin must not expose ports.');
  const env = config?.Env;
  if (!Array.isArray(env) || !env.includes('GOE_REAL_WRITES_ENABLED=true')) throw new Error('Missing immutable distribution write capability.');
  if (env.some((entry) => typeof entry !== 'string' || /^(?:HCU_AUTHTOKEN|HCU_WS_URL|HCU_CLIENTID|TOKEN|CLIENTID|ACTIVATION_KEY|NODE_TLS_REJECT_UNAUTHORIZED)=/.test(entry))) {
    throw new Error('Development credentials or global TLS configuration must not be embedded.');
  }
  let metadata;
  try { metadata = JSON.parse(config?.Labels?.['de.eq3.hmip.plugin.metadata']); }
  catch { throw new Error('Missing or invalid HCU metadata label.'); }
  if (metadata?.pluginId !== 'com.psd.hcu.goe.loadmanagement' || metadata.version !== '0.1.0' ||
      metadata.issuer !== 'PSD' || metadata.hcuMinVersion !== '1.4.7' || metadata.scope !== 'LOCAL' ||
      metadata.logsEnabled !== true || metadata.friendlyName?.de !== 'go-e Lastmanagement' ||
      typeof metadata.description?.de !== 'string' || metadata.description.de.length === 0) {
    throw new Error('HCU metadata does not match version 0.1.0.');
  }
  return { imageId: image.Id, sizeBytes: image.Size, platform: 'linux/arm64', pluginId: metadata.pluginId, version: metadata.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node validate-hcu-image.mjs <inspect.json>');
    const result = validateHcuImage(JSON.parse(await readFile(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Image validation failed.');
    process.exitCode = 1;
  }
}
