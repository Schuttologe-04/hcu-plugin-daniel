import { failure, success, type Result } from '../../domain/errors.js';

export interface HcuConnectionSettings {
  readonly url: string;
  readonly authtoken: string;
  readonly pluginId: string;
  readonly allowSelfSigned: boolean;
}

export interface ResolvedHcuEnvironment extends HcuConnectionSettings {
  readonly dataDirectory: string;
  /** Installed-runtime metadata; neither field substitutes for the plugin identifier. */
  readonly clientId?: string;
  readonly sgtin?: string;
}

export interface HcuEnvironment {
  resolve(): Promise<Result<ResolvedHcuEnvironment>>;
}

/** Require credential-free WSS URLs so tokens cannot leak through URLs or redirects. */
export function validateHcuConnectionSettings(settings: HcuConnectionSettings): Result<HcuConnectionSettings> {
  try {
    const url = new URL(settings.url);
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '') || settings.url !== settings.url.trim()) {
      return failure('ConfigurationError', 'HCU_WS_URL must be a WSS address without credentials, path, query or fragment.');
    }
  } catch {
    return failure('ConfigurationError', 'HCU_WS_URL must be a valid WSS address.');
  }
  if (!settings.authtoken || /\s/.test(settings.authtoken)) {
    return failure('ConfigurationError', 'HCU_AUTHTOKEN must be set to a nonempty token without whitespace.');
  }
  if (!settings.pluginId || /\s/.test(settings.pluginId)) {
    return failure('ConfigurationError', 'HCU_PLUGIN_ID must be a nonempty identifier without whitespace.');
  }
  if (typeof settings.allowSelfSigned !== 'boolean') {
    return failure('ConfigurationError', 'HCU_ALLOW_SELF_SIGNED must be explicitly true or false.');
  }
  return success(settings);
}
