import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { ApplyInput, GameRepository, SyncScope } from '../src/db/games.ts';
import { type IndexerClient, IndexerError } from '../src/indexer/client.ts';
import { threadSchema } from '../src/indexer/schemas.ts';
import { createApp } from '../src/server/app.ts';
import { createSyncController } from '../src/sync/controller.ts';
import { captureLogger, fixture } from './helpers.ts';

const TOKEN = 'a-token-of-16-chars+';
const gameThread = v.parse(threadSchema, fixture('full-game'));

const setup = (
  overrides: {
    client?: Partial<IndexerClient>;
    repository?: Partial<GameRepository>;
  } = {},
) => {
  const calls = {
    scopes: [] as SyncScope[],
    applied: [] as ApplyInput[],
  };
  const client: IndexerClient = {
    fast: async (ids) => new Map(ids.map((id) => [id, 1782662170])),
    full: async () => gameThread,
    raw: async () => gameThread,
    ...overrides.client,
  };
  const repository: GameRepository = {
    listTracked: async (scope) => {
      calls.scopes.push(scope);
      return [{ id: 1000, lastChange: 1 }];
    },
    findGame: async (id) =>
      id === 7 ? { id: 7, threadId: 1000, origin: 'F95zone' } : null,
    applyThread: async (input) => {
      calls.applied.push(input);
      return { games: 1, editions: 2 };
    },
    markChecked: async () => {},
    ...overrides.repository,
  };
  const captured = captureLogger();
  const logger = captured.logger;
  const controller = createSyncController(
    {
      client,
      fullConcurrency: 2,
      sinkFor: () => ({
        onUpdate() {},
        onUnchanged() {},
        onNotFound() {},
        onFailure() {},
      }),
    },
    logger,
  );
  return {
    calls,
    captured,
    controller,
    app: createApp({
      controller,
      repository,
      client,
      authToken: TOKEN,
      logger,
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

describe('authentification', () => {
  test('/health ne demande pas de token', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
  });

  test('toutes les autres routes refusent une requête sans bon token', async () => {
    const { app } = setup();
    const routes: [string, string][] = [
      ['POST', '/sync'],
      ['GET', '/status'],
      ['POST', '/games/7/refresh'],
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

describe('POST /sync', () => {
  test('lit les jeux à suivre en base selon le scope, « all » par défaut', async () => {
    const { app, calls, controller } = setup();

    const response = await call(app, 'POST', '/sync', { scope: 'active' });
    await controller.stop();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      started: true,
      scope: 'active',
      source: 'fast',
      total: 1,
    });

    await call(app, 'POST', '/sync');
    await controller.stop();
    expect(calls.scopes).toEqual(['active', 'all']);
  });

  test('les jeux inactifs passent par /raw, sans /fast', async () => {
    const paths: string[] = [];
    const { app, controller } = setup({
      client: {
        fast: async (ids) => {
          paths.push('fast');
          return new Map(ids.map((id) => [id, 1782662170]));
        },
        raw: async () => {
          paths.push('raw');
          return gameThread;
        },
      },
    });

    const response = await call(app, 'POST', '/sync', { scope: 'inactive' });
    await controller.whenIdle();

    expect(await response.json()).toMatchObject({ source: 'raw' });
    expect(paths).toEqual(['raw']);
  });

  test('refuse un scope inconnu', async () => {
    const { app } = setup();
    expect((await call(app, 'POST', '/sync', { scope: 'tout' })).status).toBe(
      400,
    );
  });

  test('ne démarre rien quand aucun jeu n’est à suivre', async () => {
    const { app, controller } = setup({
      repository: { listTracked: async () => [] },
    });

    const response = await call(app, 'POST', '/sync');

    expect(await response.json()).toEqual({ started: false, total: 0 });
    expect(controller.status().state).toBe('idle');
  });

  test('un second /sync pendant un cycle en cours renvoie 409', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, controller } = setup({
      client: {
        fast: async (ids) => {
          await gate;
          return new Map(ids.map((id) => [id, 1]));
        },
      },
    });

    expect((await call(app, 'POST', '/sync')).status).toBe(202);
    expect((await call(app, 'POST', '/sync')).status).toBe(409);
    expect(controller.status().state).toBe('running');

    release();
    await controller.stop();
    expect(controller.status().state).toBe('idle');
  });
});

describe('POST /games/:gameId/refresh', () => {
  test('n’écrase pas le nom par défaut', async () => {
    const { app, calls } = setup();

    const response = await call(app, 'POST', '/games/7/refresh');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls.applied).toEqual([
      {
        threadId: 1000,
        lastChange: 1782662170,
        thread: gameThread,
        updateName: false,
      },
    ]);
    expect(body).toMatchObject({
      gameId: 7,
      threadId: 1000,
      nameUpdated: false,
      games: 1,
      editions: 2,
    });
  });

  test('met à jour le nom pour un nouveau jeu (updateName)', async () => {
    const { app, calls } = setup();

    const response = await call(app, 'POST', '/games/7/refresh', {
      updateName: true,
    });

    expect(
      ((await response.json()) as { nameUpdated: boolean }).nameUpdated,
    ).toBe(true);
    expect(calls.applied[0]?.updateName).toBe(true);
  });

  test('404 pour un jeu inconnu, 422 pour une origine ou un thread non pris en charge', async () => {
    const unknown = setup();
    expect((await call(unknown.app, 'POST', '/games/8/refresh')).status).toBe(
      404,
    );

    const other = setup({
      repository: {
        findGame: async () => ({ id: 7, threadId: 5, origin: 'LewdCorner' }),
      },
    });
    const otherResponse = await call(other.app, 'POST', '/games/7/refresh');
    expect(otherResponse.status).toBe(422);
    expect(await otherResponse.json()).toEqual({ error: 'unsupported_origin' });

    const noThread = setup({
      repository: {
        findGame: async () => ({ id: 7, threadId: null, origin: 'F95zone' }),
      },
    });
    expect((await call(noThread.app, 'POST', '/games/7/refresh')).status).toBe(
      422,
    );
    expect(other.calls.applied).toHaveLength(0);
  });

  test('un id ou un corps invalide renvoie 400', async () => {
    const { app } = setup();

    expect((await call(app, 'POST', '/games/abc/refresh')).status).toBe(400);
    expect(
      (await call(app, 'POST', '/games/7/refresh', { updateName: 'oui' }))
        .status,
    ).toBe(400);
  });

  test('un thread supprimé renvoie 404 et rien n’est écrit', async () => {
    const { app, calls } = setup({
      client: {
        full: async () => {
          throw new IndexerError('not_found', 'THREAD_MISSING');
        },
      },
    });

    const response = await call(app, 'POST', '/games/7/refresh');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'thread_not_found' });
    expect(calls.applied).toHaveLength(0);
  });

  test('une API F95Checker en panne renvoie 502', async () => {
    const { app } = setup({
      client: {
        fast: async () => {
          throw new IndexerError('network', 'timeout');
        },
      },
    });

    expect((await call(app, 'POST', '/games/7/refresh')).status).toBe(502);
  });
});

describe('GET /threads/:threadId', () => {
  test('renvoie les infos d’un nouveau jeu avec le statut converti, sans rien écrire', async () => {
    const { app, calls } = setup();

    const response = await call(app, 'GET', '/threads/1000');
    const body = (await response.json()) as {
      editionStatus: string;
      lastChange: number;
      thread: { name: string };
    };

    expect(response.status).toBe(200);
    expect(body.thread.name).toBe('Homeless School Girl');
    expect(body.editionStatus).toBe('completed');
    expect(body.lastChange).toBe(1782662170);
    expect(calls.applied).toHaveLength(0);
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

    await call(app, 'POST', '/sync', undefined, 'mauvais');
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

  test('une actualisation manuelle est journalisée avec ce qui a été touché', async () => {
    const { app, captured } = setup();

    await call(app, 'POST', '/games/7/refresh', { updateName: true });

    expect(captured.events('game.refreshed')[0]?.scraper).toMatchObject({
      gameId: 7,
      threadId: 1000,
      updateName: true,
      games: 1,
      editions: 2,
    });
  });
});
