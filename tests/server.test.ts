import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { type IndexerClient, IndexerError } from '../src/indexer/client.ts';
import { threadSchema } from '../src/indexer/schemas.ts';
import { CHECK_MAX_THREADS, createApp } from '../src/server/app.ts';
import { captureLogger, fixture } from './helpers.ts';

const TOKEN = 'a-token-of-16-chars+';
const TS = 1782662170;
const gameThread = v.parse(threadSchema, fixture('full-game'));

const setup = (overrides: { client?: Partial<IndexerClient> } = {}) => {
  const calls = { fast: [] as number[][], full: [] as number[] };
  const client: IndexerClient = {
    fast: async (ids) => {
      calls.fast.push(ids);
      return new Map(ids.map((id) => [id, TS]));
    },
    full: async (id) => {
      calls.full.push(id);
      return gameThread;
    },
    raw: async () => gameThread,
    ...overrides.client,
  };
  const captured = captureLogger();
  return {
    calls,
    captured,
    app: createApp({
      client,
      fullConcurrency: 2,
      authToken: TOKEN,
      logger: captured.logger,
    }),
  };
};

type App = ReturnType<typeof setup>['app'];

const call = (
  app: App,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
) =>
  app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// biome-ignore lint/suspicious/noExplicitAny: corps JSON lus nettement plus simplement en test
type Results = { results: Record<string, any>[] };

describe('authentification', () => {
  test('/health ne demande pas de token', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
  });

  test('toutes les autres routes refusent une requête sans bon token', async () => {
    const { app } = setup();
    const routes: [string, string][] = [
      ['POST', '/threads/check'],
      ['GET', '/threads/1000'],
    ];

    for (const [method, path] of routes) {
      expect((await call(app, method, path, undefined, null)).status).toBe(401);
      expect((await call(app, method, path, undefined, 'mauvais')).status).toBe(
        401,
      );
    }
  });
});

describe('POST /threads/check', () => {
  test('appelle /full seulement pour les threads nouveaux ou modifiés', async () => {
    const { app, calls } = setup();

    const response = await call(app, 'POST', '/threads/check', {
      threads: [
        { id: 1, lastChange: TS },
        { id: 2, lastChange: TS - 1 },
        { id: 3 },
      ],
    });
    const { results } = (await response.json()) as Results;

    expect(response.status).toBe(200);
    expect(calls.full.sort()).toEqual([2, 3]);
    expect(results.map((r) => [r.id, r.result])).toEqual([
      [1, 'unchanged'],
      [2, 'changed'],
      [3, 'changed'],
    ]);
    expect(results[0]).toEqual({ id: 1, result: 'unchanged', lastChange: TS });
    expect(results[1]).toMatchObject({
      lastChange: TS,
      status: 'completed',
      thread: { name: 'Homeless School Girl' },
    });
  });

  test('renvoie les threads supprimés et les échecs sans faire échouer le lot', async () => {
    const { app } = setup({
      client: {
        full: async (id) => {
          if (id === 2) throw new IndexerError('not_found', 'THREAD_MISSING');
          if (id === 3) throw new IndexerError('network', 'timeout');
          return gameThread;
        },
      },
    });

    const response = await call(app, 'POST', '/threads/check', {
      threads: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    const { results } = (await response.json()) as Results;

    expect(response.status).toBe(200);
    expect(results.map((r) => r.result)).toEqual([
      'changed',
      'not_found',
      'failed',
    ]);
    expect(results[2]).toMatchObject({ kind: 'network', message: 'timeout' });
  });

  test('un /fast en échec marque tout son paquet en échec', async () => {
    const { app } = setup({
      client: {
        fast: async () => {
          throw new IndexerError('http', 'HTTP 503');
        },
      },
    });

    const response = await call(app, 'POST', '/threads/check', {
      threads: [{ id: 1, lastChange: TS }, { id: 2 }],
    });
    const { results } = (await response.json()) as Results;

    expect(results.map((r) => [r.result, r.kind])).toEqual([
      ['failed', 'http'],
      ['failed', 'http'],
    ]);
  });

  test('ignore les doublons et garde l’ordre reçu', async () => {
    const { app, calls } = setup();

    const response = await call(app, 'POST', '/threads/check', {
      threads: [{ id: 5 }, { id: 4 }, { id: 5 }],
    });
    const { results } = (await response.json()) as Results;

    expect(results.map((r) => r.id)).toEqual([5, 4]);
    expect(calls.fast).toEqual([[5, 4]]);
  });

  test('refuse un corps invalide, vide ou trop gros', async () => {
    const { app, calls } = setup();
    const tooMany = Array.from({ length: CHECK_MAX_THREADS + 1 }, (_, i) => ({
      id: i + 1,
    }));

    for (const body of [
      undefined,
      { threads: [] },
      { threads: tooMany },
      { threads: [{ id: 0 }] },
      { threads: [{ id: 1, lastChange: 'hier' }] },
    ]) {
      expect((await call(app, 'POST', '/threads/check', body)).status).toBe(
        400,
      );
    }
    expect(calls.fast).toHaveLength(0);
  });
});

describe('GET /threads/:threadId', () => {
  test('renvoie les données fraîches avec le statut converti', async () => {
    const { app } = setup();

    const response = await call(app, 'GET', '/threads/1000');
    const body = (await response.json()) as {
      status: string;
      lastChange: number;
      thread: { name: string };
    };

    expect(response.status).toBe(200);
    expect(body.thread.name).toBe('Homeless School Girl');
    expect(body.status).toBe('completed');
    expect(body.lastChange).toBe(TS);
  });

  test('un thread supprimé renvoie 404', async () => {
    const { app } = setup({
      client: {
        full: async () => {
          throw new IndexerError('not_found', 'THREAD_MISSING');
        },
      },
    });

    expect((await call(app, 'GET', '/threads/1000')).status).toBe(404);
  });

  test('refuse un id de thread invalide', async () => {
    const { app } = setup();

    expect((await call(app, 'GET', '/threads/0')).status).toBe(400);
    expect((await call(app, 'GET', '/threads/1000000')).status).toBe(400);
  });
});

describe('logs', () => {
  test('journal d’accès : méthode, route, statut et durée, sans le healthcheck', async () => {
    const { app, captured } = setup();

    await app.request('/health');
    await call(app, 'GET', '/threads/1000');

    const access = captured.events('http.request');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      log: { level: 'info' },
      message: 'GET /threads/1000 200',
      scraper: {
        method: 'GET',
        path: '/threads/1000',
        route: '/threads/:threadId',
        status: 200,
      },
    });
    expect(typeof access[0]?.scraper.durationMs).toBe('number');
  });

  test('un token refusé est un warn ; une panne de l’API est un 502 en error, avec la cause en warn', async () => {
    const { app, captured } = setup({
      client: {
        fast: async () => {
          throw new IndexerError('network', 'timeout');
        },
      },
    });

    await call(app, 'GET', '/threads/1000', undefined, 'mauvais');
    await call(app, 'GET', '/threads/1000');

    expect(
      captured
        .events('http.request')
        .map((l) => [l.scraper.status, l.log.level]),
    ).toEqual([
      [401, 'warn'],
      [502, 'error'],
    ]);
    expect(captured.events('indexer.error')[0]).toMatchObject({
      log: { level: 'warn' },
      scraper: { kind: 'network' },
    });
  });

  test('une vérification par lot est journalisée avec ses compteurs', async () => {
    const { app, captured } = setup();

    await call(app, 'POST', '/threads/check', {
      threads: [{ id: 1, lastChange: TS }, { id: 2 }],
    });

    expect(captured.events('threads.checked')[0]?.scraper).toMatchObject({
      total: 2,
      changed: 1,
      unchanged: 1,
      notFound: 0,
      failed: 0,
    });
  });
});
