import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import * as v from 'valibot';
import { type IndexerClient, IndexerError } from '../indexer/client.ts';
import type { Logger } from '../logger.ts';
import { threadStatus } from '../mapping.ts';
import { checkThreads } from '../sync/check.ts';
import { fetchLatest } from '../sync/latest.ts';

//? Au-delà, une requête dépasse la minute (5 paquets `/fast` de 10, à la file) : à l'appelant
//? de découper.
export const CHECK_MAX_THREADS = 50;

//? Ids de thread F95 : entiers positifs.
const threadId = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(999_999),
);

const threadIdParam = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  threadId,
);

const checkBodySchema = v.object({
  threads: v.pipe(
    v.array(
      v.object({
        id: threadId,
        //? Timestamp renvoyé par un précédent appel. Absent ou nul : thread jamais vérifié, `/full` forcé.
        lastChange: v.optional(
          v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
          null,
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(CHECK_MAX_THREADS),
  ),
});

export interface AppDeps {
  client: IndexerClient;
  fullConcurrency: number;
  authToken: string;
  logger: Logger;
}

export const createApp = ({
  client,
  fullConcurrency,
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

  app.use('/threads/*', bearerAuth({ token: authToken }));

  //? Remplace `checker.php` pour l'auto-check de f95-france : rien n'est écrit, l'appelant
  //? conserve `lastChange` et le renvoie au passage suivant pour éviter les `/full` inutiles.
  app.post('/threads/check', async (c) => {
    const body = v.safeParse(
      checkBodySchema,
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) {
      return c.json(
        { error: 'invalid_body', issues: v.flatten(body.issues) },
        400,
      );
    }

    const results = await checkThreads(body.output.threads, {
      client,
      fullConcurrency,
      //? L'appelant a abandonné : inutile de continuer à solliciter l'API.
      signal: c.req.raw.signal,
    });
    const count = (result: string) =>
      results.filter((r) => r.result === result).length;
    logger.info(
      {
        event: 'threads.checked',
        total: results.length,
        changed: count('changed'),
        unchanged: count('unchanged'),
        notFound: count('not_found'),
        failed: count('failed'),
      },
      `${results.length} threads vérifiés`,
    );
    return c.json({ results });
  });

  //? Données fraîches d'un thread (ajout d'un jeu, scrape manuel), sans comparer à un `lastChange`.
  app.get('/threads/:threadId', async (c) => {
    const id = v.safeParse(threadIdParam, c.req.param('threadId'));
    if (!id.success) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const { lastChange, thread } = await fetchLatest(client, id.output);
    return c.json({
      threadId: id.output,
      lastChange,
      status: threadStatus(thread.status),
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
