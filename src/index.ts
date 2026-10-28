import { loadConfig } from './config.ts';
import { createIndexerClient } from './indexer/client.ts';
import { serializeFast } from './indexer/serialize.ts';
import { createLogger } from './logger.ts';
import { createApp } from './server/app.ts';

const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  serviceName: config.serviceName,
  environment: config.environment,
});

//? Au-delà, l'API de WillyJL est probablement congestionnée : à voir dans Kibana avant d'incriminer le scraper.
const SLOW_REQUEST_MS = 30_000;

//? Un seul client pour tout le service : c'est lui qui garantit qu'aucun `/fast` ne part en parallèle,
//? même quand plusieurs vérifications arrivent en même temps.
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
const server = Bun.serve({
  port: config.port,
  fetch: createApp({
    client,
    fullConcurrency: config.fullConcurrency,
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

//? Coolify envoie SIGTERM à chaque redéploiement : on laisse finir les requêtes en cours.
const shutdown = async () => {
  logger.info('arrêt demandé');
  await server.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
