import { describe, expect, test } from 'bun:test';
import {
  createIndexerClient,
  type IndexerError,
  type RequestInfo,
} from '../src/indexer/client.ts';
import { fixture, jsonResponse } from './helpers.ts';

const setup = (respond: (url: URL, init: RequestInit) => Response) => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = createIndexerClient({
    baseUrl: 'https://indexer.test/',
    userAgent: 'test-agent/1.0',
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof fetch,
  });
  return { client, calls };
};

const firstCall = (calls: { url: URL; init: RequestInit }[]) => {
  const call = calls[0];
  if (!call) throw new Error("aucun appel n'a été fait");
  return { path: call.url.pathname + call.url.search, init: call.init };
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as IndexerError;
  }
  throw new Error('la promesse aurait dû être rejetée');
};

describe('fast', () => {
  test('renvoie les timestamps par id et envoie le User-Agent', async () => {
    const { client, calls } = setup(() => jsonResponse(fixture('fast')));

    const timestamps = await client.fast([1000, 5000]);

    expect(timestamps.get(1000)).toBe(1782662170);
    expect(timestamps.size).toBe(10);
    expect(firstCall(calls).path).toBe('/fast?ids=1000,5000');
    expect(
      (firstCall(calls).init.headers as Record<string, string>)['user-agent'],
    ).toBe('test-agent/1.0');
  });

  test('refuse plus de 10 ids sans appeler le réseau', async () => {
    const { client, calls } = setup(() => jsonResponse({}));
    const ids = Array.from({ length: 11 }, (_, i) => i + 1);

    expect((await failure(client.fast(ids))).kind).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  test('refuse un id hors de 1..999999', async () => {
    const { client } = setup(() => jsonResponse({}));

    expect((await failure(client.fast([0]))).kind).toBe('bad_request');
    expect((await failure(client.fast([1_000_000]))).kind).toBe('bad_request');
  });
});

describe('full', () => {
  test('passe le timestamp en paramètre et décode le thread', async () => {
    const { client, calls } = setup(() => jsonResponse(fixture('full-game')));

    const thread = await client.full(1000, 1782662170);

    expect(thread.name).toBe('Homeless School Girl');
    expect(firstCall(calls).path).toBe('/full/1000?ts=1782662170');
  });

  test('404 THREAD_MISSING devient not_found', async () => {
    const { client } = setup(() =>
      jsonResponse(fixture('full-thread-missing'), 404),
    );

    const error = await failure(client.full(400000, 1788479891));

    expect(error.kind).toBe('not_found');
    expect(error.options.code).toBe('THREAD_MISSING');
  });

  test('INDEX_ERROR non vide sur un 200 devient index_error', async () => {
    const { client } = setup(() =>
      jsonResponse({
        INDEX_ERROR: 'PARSE_FAILED',
        LAST_CACHED: '1',
        EXPIRE_TIME: '2',
      }),
    );

    expect((await failure(client.full(1, 1))).kind).toBe('index_error');
  });

  test('400 et 406 sont des bad_request', async () => {
    for (const status of [400, 406]) {
      const { client } = setup(() => jsonResponse({ detail: 'x' }, status));
      expect((await failure(client.full(1, 1))).kind).toBe('bad_request');
    }
  });

  test('un corps qui ne respecte pas le contrat est invalid_response', async () => {
    const { client } = setup(() =>
      jsonResponse({ INDEX_ERROR: '', name: 'x' }),
    );

    expect((await failure(client.full(1, 1))).kind).toBe('invalid_response');
  });

  test('une erreur réseau devient network', async () => {
    const client = createIndexerClient({
      baseUrl: 'https://indexer.test',
      userAgent: 'test',
      fetch: (async () => {
        throw new TypeError('connexion refusée');
      }) as unknown as typeof fetch,
    });

    expect((await failure(client.full(1, 1))).kind).toBe('network');
  });
});

describe('onRequest', () => {
  test('signale chaque requête avec son statut, sa durée et le cache Cloudflare', async () => {
    const infos: RequestInfo[] = [];
    const client = createIndexerClient({
      baseUrl: 'https://indexer.test',
      userAgent: 'test',
      onRequest: (info) => infos.push(info),
      fetch: (async () =>
        new Response(JSON.stringify(fixture('fast')), {
          headers: { 'cf-cache-status': 'HIT' },
        })) as unknown as typeof fetch,
    });

    await client.fast([1000]);

    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      path: '/fast?ids=1000',
      status: 200,
      cache: 'HIT',
    });
    expect(infos[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('signale aussi une requête qui n’a pas abouti', async () => {
    const infos: RequestInfo[] = [];
    const client = createIndexerClient({
      baseUrl: 'https://indexer.test',
      userAgent: 'test',
      onRequest: (info) => infos.push(info),
      fetch: (async () => {
        throw new TypeError('connexion refusée');
      }) as unknown as typeof fetch,
    });

    await failure(client.full(1, 1));

    expect(infos[0]).toMatchObject({ status: null, cache: null });
    expect(infos[0]?.error).toContain('connexion refusée');
  });
});

describe('raw', () => {
  test('appelle /raw sans timestamp', async () => {
    const { client, calls } = setup(() =>
      jsonResponse(fixture('raw-empty-thread')),
    );

    await client.raw(5000);

    expect(firstCall(calls).path).toBe('/raw/5000');
  });
});
