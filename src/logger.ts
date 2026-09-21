import type { Writable } from 'node:stream';
import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  level: string;
  serviceName?: string;
  environment?: string;
  /** Destination : la sortie standard par défaut (remplacée dans les tests). */
  stream?: Writable;
}

//? Une ligne JSON par log sur la sortie standard : c'est au collecteur (Filebeat, Elastic Agent…)
//? de l'expédier vers Elasticsearch. Champs ECS standard (`@timestamp`, `log.level`, `message`,
//? `service.*`, `event.*`, `error.*`). Tout ce qui est passé à l'appel de log va sous `scraper`,
//? pour ne pas polluer le mapping avec des champs libres. `event` est le nom de l'événement,
//? repris dans `event.action`.
export const createLogger = ({
  level,
  serviceName = 'f95list-scraper',
  environment = 'unknown',
  stream = process.stdout,
}: LoggerOptions): Logger =>
  pino(
    {
      level,
      messageKey: 'message',
      timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
      base: {
        service: { name: serviceName, type: 'bun', environment },
      },
      formatters: {
        level: (label) => ({ log: { level: label } }),
        log: ({ err, event, ...rest }) => ({
          event: {
            dataset: serviceName,
            ...(typeof event === 'string' ? { action: event } : {}),
          },
          ...(err
            ? {
                error: {
                  type: (err as Error).name,
                  message: (err as Error).message,
                  stack_trace: (err as Error).stack,
                },
              }
            : {}),
          ...(Object.keys(rest).length > 0 ? { scraper: rest } : {}),
        }),
      },
    },
    stream,
  );
