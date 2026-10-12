import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoEHttpClient } from '../../../src/goe/http-client.js';

afterEach(() => vi.useRealTimers());

describe('GoEHttpClient', () => {
  it('uses only GET on the fixed status endpoint and encodes the filter', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ccp":[123]}'));
    const result = await new GoEHttpClient({ fetch: fetchMock }).readStatus('controller.local:8080', ['ccn', 'ccp', 'cpc']);
    expect(result).toEqual({ ok: true, value: { ccp: [123] } });
    const [input, options] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin).toBe('http://controller.local:8080');
    expect(url.pathname).toBe('/api/status');
    expect([...url.searchParams.entries()]).toEqual([['filter', 'ccn,ccp,cpc']]);
    expect(options).toMatchObject({ method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } });
    expect(options).not.toHaveProperty('body');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    '', 'http://controller.local', 'controller.local/api/set', 'controller.local?amp=6',
    'controller.local#other', 'user:secret@controller.local', 'controller.local\\api\\set',
    '999.0.0.1', '127.1', '0x7f000001', 'controller.local:0',
  ])('rejects an invalid or path-injecting host %s before HTTP', async (host) => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await new GoEHttpClient({ fetch: fetchMock }).readStatus(host, ['car']))
      .toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports an IPv6 authority without changing the endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    expect(await new GoEHttpClient({ fetch: fetchMock }).readStatus('[::1]:8080', ['car'])).toMatchObject({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://[::1]:8080/api/status?filter=car');
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s before HTTP', async (timeoutMs) => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await new GoEHttpClient({ timeoutMs, fetch: fetchMock }).readStatus('charger.local', ['car']))
      .toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[], ['car&amp=6'], ['../set'], [''], ['car,amp']].map((fields) => ({ fields })))('rejects malformed field lists $fields', async ({ fields }) => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', fields))
      .toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 401, 404, 500])('returns a bounded failure for HTTP %s without redirect/retry', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret response', {
      status, headers: { location: 'http://charger.local/api/set?amp=6' },
    }));
    const result = await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    expect(result).toEqual({ ok: false, error: { code: 'ConnectionError', message: `Status request returned HTTP ${status}.` } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('contains network exceptions without exposing their native message', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('token=secret; native-stack-data'));
    const result = await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    expect(result).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['{broken', '', '<html>Login token=secret</html>'])('identifies invalid JSON without exposing its body', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    expect(result).toEqual({ ok: false, error: { code: 'InvalidResponseError', message: 'Status response is not valid JSON.' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('leaves valid JSON as unknown so device mappers must validate its structure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('null'));
    expect(await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']))
      .toEqual({ ok: true, value: null });
  });

  it('aborts at the default 3000 ms deadline and clears the timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    });
    const pending = new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    await vi.advanceTimersByTimeAsync(2999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: { code: 'TimeoutError', message: 'Status request timed out after 3000 ms.' } });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('also applies the deadline while a response body is stalled', async () => {
    vi.useFakeTimers();
    const response = new Response('{}');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      vi.spyOn(response, 'text').mockImplementation(() => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('body aborted')));
      }));
      return response;
    });
    const pending = new GoEHttpClient({ timeoutMs: 50, fetch: fetchMock }).readStatus('charger.local', ['car']);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TimeoutError' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains failures while reading the body', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'text').mockRejectedValue(new Error('secret body read failure'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    expect(result).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('clears its deadline after a successful request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await new GoEHttpClient({ fetch: fetchMock }).readStatus('charger.local', ['car']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
