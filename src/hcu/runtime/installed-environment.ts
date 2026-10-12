import { readFile } from 'node:fs/promises';
import { failure, success, type Result } from '../../domain/errors.js';
import { PLUGIN_ID } from '../plugin-identity.js';
import { validateHcuConnectionSettings, type HcuEnvironment, type ResolvedHcuEnvironment } from './hcu-environment.js';

export interface InstalledHcuEnvironmentOptions {
  readonly pluginId?: string;
  readonly allowSelfSigned?: boolean;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Installed mount parsing only; never registers a client or creates credentials. */
export class InstalledHcuEnvironment implements HcuEnvironment {
  constructor(readonly options: InstalledHcuEnvironmentOptions = {}) {}

  async resolve(): Promise<Result<ResolvedHcuEnvironment>> {
    const readText = this.options.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
    try {
      const [tokenText, clientText, sgtinText] = await Promise.all([
        readText('/TOKEN'), readText('/CLIENTID'), readText('/SGTIN'),
      ]);
      const clientId = clientText.trim();
      const sgtin = sgtinText.trim();
      const token = tokenText.trim();
      const validFileValue = (value: string): boolean => value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/u.test(value);
      if (!validFileValue(clientId) || !validFileValue(sgtin) || !validFileValue(token)) {
        return failure('ConfigurationError', 'Installed HCU runtime metadata is missing or malformed.');
      }
      const settings = validateHcuConnectionSettings({
        url: 'wss://host.containers.internal:9001',
        authtoken: token,
        pluginId: this.options.pluginId ?? PLUGIN_ID,
        allowSelfSigned: this.options.allowSelfSigned ?? false,
      });
      if (!settings.ok) return settings;
      return success({ ...settings.value, dataDirectory: '/data', clientId, sgtin });
    } catch {
      return failure('ConfigurationError', 'Unable to read the installed HCU runtime files.');
    }
  }
}
