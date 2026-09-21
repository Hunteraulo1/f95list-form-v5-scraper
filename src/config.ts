import * as v from 'valibot';
import pkg from '../package.json';

const port = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.minValue(1),
  v.maxValue(65_535),
);

const concurrency = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.minValue(1),
  v.maxValue(50),
);

const envSchema = v.object({
  F95INDEXER_URL: v.optional(
    v.pipe(v.string(), v.url()),
    'https://api.f95checker.dev',
  ),
  USER_AGENT_CONTACT: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    'https://github.com/Hunteraulo1/f95list-form-v5-scraper',
  ),
  PORT: v.optional(port, '3000'),
  //? Base du projet principal (MariaDB). Le schéma appartient à ce projet : le scraper ne migre rien.
  DATABASE_URL: v.pipe(v.string(), v.url()),
  AUTH_TOKEN: v.pipe(v.string(), v.minLength(16)),
  FULL_CONCURRENCY: v.optional(concurrency, '5'),
  //? Champs `service.name` et `service.environment` des logs.
  SERVICE_NAME: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    'f95list-scraper',
  ),
  APP_ENV: v.optional(v.pipe(v.string(), v.minLength(1)), 'unknown'),
  LOG_LEVEL: v.optional(
    v.picklist(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    'info',
  ),
});

export type Config = ReturnType<typeof loadConfig>;

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
) => {
  const result = v.safeParse(envSchema, env);
  if (!result.success) {
    throw new Error(`Configuration invalide :\n${v.summarize(result.issues)}`);
  }
  const {
    F95INDEXER_URL,
    USER_AGENT_CONTACT,
    PORT,
    DATABASE_URL,
    AUTH_TOKEN,
    FULL_CONCURRENCY,
    SERVICE_NAME,
    APP_ENV,
    LOG_LEVEL,
  } = result.output;

  return {
    indexerUrl: F95INDEXER_URL,
    //? Distinctif, demandé par WillyJL pour identifier chaque projet en cas de congestion.
    userAgent: `f95list-scraper/${pkg.version} (+${USER_AGENT_CONTACT})`,
    port: PORT,
    databaseUrl: DATABASE_URL,
    authToken: AUTH_TOKEN,
    fullConcurrency: FULL_CONCURRENCY,
    logLevel: LOG_LEVEL,
    serviceName: SERVICE_NAME,
    environment: APP_ENV,
  };
};
