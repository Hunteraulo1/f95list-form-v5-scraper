import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import * as v from 'valibot';
import type { GameRepository } from '../db/games.ts';
import { type IndexerClient, IndexerError } from '../indexer/client.ts';
import type { Logger } from '../logger.ts';
import { editionStatus } from '../mapping.ts';
import type { SyncController } from '../sync/controller.ts';
import { fetchLatest } from '../sync/latest.ts';
import { refreshGame } from '../sync/refresh.ts';

//? Ids MySQL (`mediumint unsigned` pour `game.id`) et ids de thread F95 : entiers positifs.
const idParam = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
  v.maxValue(16_777_215),
);

const syncBodySchema = v.object({
  scope: v.optional(v.picklist(['active', 'inactive', 'all']), 'all'),
});

const refreshBodySchema = v.object({
  //? Faux par défaut : une actualisation ne doit pas écraser un nom corrigé à la main.
  updateName: v.optional(v.boolean(), false),
});

export interface AppDeps {
  controller: SyncController;
  repository: GameRepository;
  client: IndexerClient;
  authToken: string;
  logger: Logger;
}

export const createApp = ({
  controller,
  repository,
  client,
  authToken,
  logger,
}: AppDeps) => {
  const app = new Hono();

  //? Journal d'accès : qui appelle quoi, avec quel résultat et en combien de temps. Le healthcheck
  //? (toutes les 30 s) est exclu pour ne pas noyer les logs.
  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    if (c.req.path === '/health') return;

    const status = c.res.status;
    logger[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'](
      {
        event: 'http.request',
        method: c.req.method,
        path: c.req.path,
        route: routePath(c, -1),
        status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      `${c.req.method} ${c.req.path} ${status}`,
    );
  });

  //? Healthcheck Coolify : sans authentification.
  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/sync', bearerAuth({ token: authToken }));
  app.use('/status', bearerAuth({ token: authToken }));
  app.use('/games/*', bearerAuth({ token: authToken }));
  app.use('/threads/*', bearerAuth({ token: authToken }));

  //? Répond tout de suite : le cycle peut durer des heures (première synchro à froid).
  //? Coolify : `scope: "active"` toutes les 6 h, `scope: "inactive"` une fois par jour. Les jeux
  //? inactifs passent par `/raw` : donnée possiblement périmée, mais aucun `/fast` chez WillyJL.
  app.post('/sync', async (c) => {
    const body = v.safeParse(
      syncBodySchema,
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) {
      return c.json(
        { error: 'invalid_body', issues: v.flatten(body.issues) },
        400,
      );
    }
    if (controller.status().state === 'running') {
      return c.json({ error: 'sync_already_running' }, 409);
    }

    const games = await repository.listTracked(body.output.scope);
    if (games.length === 0) {
      return c.json({ started: false, total: 0 }, 200);
    }
    const source = body.output.scope === 'inactive' ? 'raw' : 'fast';
    if (!controller.start(games, { scope: body.output.scope, source })) {
      return c.json({ error: 'sync_already_running' }, 409);
    }
    return c.json(
      {
        started: true,
        scope: body.output.scope,
        source,
        total: games.length,
      },
      202,
    );
  });

  app.get('/status', (c) => c.json(controller.status()));

  //? Actualisation manuelle d'un jeu, ou remplissage d'un nouveau jeu déjà créé (`updateName`).
  app.post('/games/:gameId/refresh', async (c) => {
    const gameId = v.safeParse(idParam, c.req.param('gameId'));
    const body = v.safeParse(
      refreshBodySchema,
      await c.req.json().catch(() => ({})),
    );
    if (!gameId.success || !body.success) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const result = await refreshGame(
      { repository, client },
      gameId.output,
      body.output,
    );
    if (!result.ok) {
      return c.json(
        { error: result.reason },
        result.reason === 'game_not_found' ? 404 : 422,
      );
    }
    logger.info(
      {
        event: 'game.refreshed',
        gameId: result.gameId,
        threadId: result.threadId,
        updateName: body.output.updateName,
        lastChange: result.lastChange,
        games: result.games,
        editions: result.editions,
      },
      `jeu ${result.gameId} actualisé manuellement`,
    );
    return c.json(result);
  });

  //? Aperçu d'un jeu qui n'existe pas encore en base : rien n'est écrit.
  app.get('/threads/:threadId', async (c) => {
    const threadId = v.safeParse(idParam, c.req.param('threadId'));
    if (!threadId.success || threadId.output > 999_999) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const { lastChange, thread } = await fetchLatest(client, threadId.output);
    return c.json({
      threadId: threadId.output,
      lastChange,
      //? Valeur de `game_edition.status` correspondante, `null` si l'API renvoie un statut inconnu.
      editionStatus: editionStatus(thread.status),
      thread,
    });
  });

  app.onError((error, c) => {
    //? Le contrôle du token (401) est lancé comme une HTTPException : on la laisse passer telle quelle.
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof IndexerError) {
      if (error.kind === 'not_found') {
        return c.json({ error: 'thread_not_found' }, 404);
      }
      logger.warn(
        { event: 'indexer.error', kind: error.kind, reason: error.message },
        'erreur API F95Checker',
      );
      return c.json({ error: error.kind, message: error.message }, 502);
    }
    logger.error(
      { event: 'http.unexpected_error', err: error },
      'erreur inattendue',
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
};
