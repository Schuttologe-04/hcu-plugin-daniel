import { isIP } from 'node:net';

/** Accept only a host authority, without a scheme, path or credentials. */
export function isValidDeviceHost(host: string): boolean {
  if (host.length === 0 || host !== host.trim() || /[\s/@?#\\%]/u.test(host)) {
    return false;
  }

  let hostname: string;
  let port: string | undefined;

  if (host.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/u.exec(host);
    if (match === null || match[1] === undefined || isIP(match[1]) !== 6) {
      return false;
    }
    hostname = match[1];
    port = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/u.exec(host);
    if (match === null || match[1] === undefined) {
      return false;
    }
    hostname = match[1];
    port = match[2];

    if (isIP(hostname) !== 4 && !isValidDnsName(hostname)) {
      return false;
    }
  }

  if (port !== undefined) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      return false;
    }
  }

  return hostname.length > 0;
}

function isValidDnsName(hostname: string): boolean {
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (name.length === 0 || name.length > 253) {
    return false;
  }

  const labels = name.split('.');
  if (!labels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
  )) {
    return false;
  }

  // The URL parser interprets numeric and hexadecimal final labels as IP
  // addresses. Reject those spellings instead of silently changing the host.
  const finalLabel = labels.at(-1);
  return finalLabel !== undefined && !/^(?:[0-9]+|0x[0-9a-f]+)$/iu.test(finalLabel);
}
