import { loadConfig } from './config.ts';
import { createGameRepository } from './db/games.ts';
import { createPool } from './db/pool.ts';
import { createIndexerClient } from './indexer/client.ts';
import { serializeFast } from './indexer/serialize.ts';
import { createLogger } from './logger.ts';
import { createApp } from './server/app.ts';
import { createSyncController } from './sync/controller.ts';
import { createDbSink } from './sync/db-sink.ts';

const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  serviceName: config.serviceName,
  environment: config.environment,
});

//? Au-delà, l'API de WillyJL est probablement congestionnée : à voir dans Kibana avant d'incriminer le scraper.
const SLOW_REQUEST_MS = 30_000;

//? Un seul client pour tout le service : c'est lui qui garantit qu'aucun `/fast` ne part en parallèle.
const client = serializeFast(
  createIndexerClient({
    baseUrl: config.indexerUrl,
    userAgent: config.userAgent,
    onRequest: ({ path, status, durationMs, cache, error }) => {
      const failed = error !== undefined || (status ?? 0) >= 500;
      const level =
        failed || durationMs > SLOW_REQUEST_MS
          ? 'warn'
          : path.startsWith('/fast')
            ? 'info'
            : 'debug';
      logger[level](
        { event: 'indexer.request', path, status, durationMs, cache, error },
        `GET ${path} ${status ?? 'échec'} (${durationMs} ms)`,
      );
    },
  }),
);
const pool = createPool(config.databaseUrl);
const repository = createGameRepository(pool);

const controller = createSyncController(
  {
    client,
    sinkFor: ({ runId }) => createDbSink(repository, logger, runId),
    fullConcurrency: config.fullConcurrency,
  },
  logger,
);

const server = Bun.serve({
  port: config.port,
  fetch: createApp({
    controller,
    repository,
    client,
    authToken: config.authToken,
    logger,
  }).fetch,
});
logger.info(
  {
    port: server.port,
    indexer: config.indexerUrl,
    userAgent: config.userAgent,
  },
  'scraper démarré',
);

//? Coolify envoie SIGTERM à chaque redéploiement : on interrompt le cycle proprement.
const shutdown = async () => {
  logger.info('arrêt demandé');
  await controller.stop();
  await server.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
