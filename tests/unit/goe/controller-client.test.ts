import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, success } from '../../../src/domain/errors.js';
import { GoEControllerClient } from '../../../src/goe/controller-client.js';
import { GoEHttpClient, type StatusReader } from '../../../src/goe/http-client.js';

const host = 'controller.local';
const payload = { ccn: ['Grid'], ccp: [18430.77734], cpc: [[1, 2, 3, null]] };

afterEach(() => vi.useRealTimers());

describe('GoEControllerClient', () => {
  it('requests exactly the filtered status fields and normalizes the response', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockResolvedValue(success(payload));
    const client = new GoEControllerClient(host, { readStatus });
    expect(await client.readStatus()).toMatchObject({
      ok: true, value: { gridPowerW: 18430.77734, host, reachable: true },
    });
    expect(readStatus).toHaveBeenCalledExactlyOnceWith(host, ['ccn', 'ccp', 'cpc']);
  });

  it('returns the explicit connection failure', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>()
      .mockResolvedValue(failure('ConnectionError', 'Device is unreachable.'));
    expect(await new GoEControllerClient(host, { readStatus }).readStatus()).toEqual({
      ok: false, error: { code: 'ConnectionError', message: 'Device is unreachable.' },
    });
  });

  it('contains rejected transport promises without exposing native exception details', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>()
      .mockRejectedValue(new Error('Private transport details'));
    expect(await new GoEControllerClient(host, { readStatus }).readStatus()).toEqual({
      ok: false, error: { code: 'ConnectionError', message: 'Controller status request failed.' },
    });
  });

  it('returns a TimeoutError when HTTP exceeds its deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    const client = new GoEControllerClient(host, new GoEHttpClient({ timeoutMs: 25, fetch: fetchMock }));
    const pending = client.readStatus();
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TimeoutError' } });
  });

  it('returns InvalidResponseError for invalid JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken', { status: 200 }));
    const client = new GoEControllerClient(host, new GoEHttpClient({ fetch: fetchMock }));
    expect(await client.readStatus()).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });
});
