import { resolve } from 'node:path';
import { failure, success, type Result } from '../../domain/errors.js';
import { PLUGIN_ID } from '../plugin-identity.js';
import { validateHcuConnectionSettings, type HcuEnvironment, type ResolvedHcuEnvironment } from './hcu-environment.js';

/** Credentials are resolved independently of the persisted functional configuration. */
export class RemoteDevelopmentEnvironment implements HcuEnvironment {
  constructor(readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  async resolve(): Promise<Result<ResolvedHcuEnvironment>> {
    const allowSelfSignedSetting = this.environment['HCU_ALLOW_SELF_SIGNED'];
    if (allowSelfSignedSetting !== undefined && allowSelfSignedSetting !== 'true' && allowSelfSignedSetting !== 'false') {
      return failure('ConfigurationError', 'HCU_ALLOW_SELF_SIGNED must be true or false; certificate checking is enabled by default.');
    }
    const settings = validateHcuConnectionSettings({
      url: this.environment['HCU_WS_URL'] ?? '',
      authtoken: this.environment['HCU_AUTHTOKEN'] ?? '',
      pluginId: this.environment['HCU_PLUGIN_ID'] ?? PLUGIN_ID,
      allowSelfSigned: allowSelfSignedSetting === 'true',
    });
    if (!settings.ok) return settings;
    const configuredDirectory = this.environment['HCU_DATA_DIR'];
    if (configuredDirectory !== undefined && configuredDirectory.trim().length === 0) {
      return failure('ConfigurationError', 'HCU_DATA_DIR must be a nonempty filesystem path.');
    }
    return success({ ...settings.value, dataDirectory: resolve(configuredDirectory ?? './data') });
  }
}
