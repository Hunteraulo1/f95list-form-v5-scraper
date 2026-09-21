import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';

const AUTH_TOKEN = 'a-token-of-16-chars+';
const DATABASE_URL = 'mysql://user:pass@localhost:3306/db';

describe('loadConfig', () => {
  test('applique les valeurs par défaut', () => {
    const config = loadConfig({ AUTH_TOKEN, DATABASE_URL });

    expect(config.indexerUrl).toBe('https://api.f95checker.dev');
    expect(config.port).toBe(3000);
    expect(config.fullConcurrency).toBe(5);
  });

  test('le User-Agent identifie le projet, sa version et un contact', () => {
    const config = loadConfig({
      AUTH_TOKEN,
      DATABASE_URL,
      USER_AGENT_CONTACT: 'me@example.com',
    });

    expect(config.userAgent).toMatch(
      /^f95list-scraper\/\d+\.\d+\.\d+ \(\+me@example\.com\)$/,
    );
  });

  test("exige un token d'au moins 16 caractères", () => {
    expect(() => loadConfig({ DATABASE_URL })).toThrow(
      'Configuration invalide',
    );
    expect(() => loadConfig({ AUTH_TOKEN: 'court', DATABASE_URL })).toThrow(
      'Configuration invalide',
    );
  });

  test('nom de service et environnement pour les logs, avec des valeurs par défaut', () => {
    expect(loadConfig({ AUTH_TOKEN, DATABASE_URL })).toMatchObject({
      serviceName: 'f95list-scraper',
      environment: 'unknown',
    });
    expect(
      loadConfig({
        AUTH_TOKEN,
        DATABASE_URL,
        SERVICE_NAME: 'scraper-v5',
        APP_ENV: 'prod',
      }),
    ).toMatchObject({ serviceName: 'scraper-v5', environment: 'prod' });
  });

  test('exige DATABASE_URL', () => {
    expect(() => loadConfig({ AUTH_TOKEN })).toThrow('Configuration invalide');
  });

  test('refuse une URL ou un port invalides', () => {
    expect(() =>
      loadConfig({ AUTH_TOKEN, DATABASE_URL, F95INDEXER_URL: 'pas-une-url' }),
    ).toThrow();
    expect(() =>
      loadConfig({ AUTH_TOKEN, DATABASE_URL, PORT: '99999' }),
    ).toThrow();
  });
});
