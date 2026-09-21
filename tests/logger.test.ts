import { describe, expect, test } from 'bun:test';
import { captureLogger } from './helpers.ts';

describe('createLogger', () => {
  test('émet des champs ECS : timestamp, niveau, message, service et event', () => {
    const { logger, lines } = captureLogger();

    logger.info('bonjour');

    const [line] = lines();
    expect(line).toMatchObject({
      log: { level: 'info' },
      message: 'bonjour',
      service: { name: 'f95list-scraper', type: 'bun', environment: 'unknown' },
      event: { dataset: 'f95list-scraper' },
    });
    expect(new Date(line?.['@timestamp']).toISOString()).toBe(
      line?.['@timestamp'],
    );
    //? Pas de champs Pino par défaut (pid, hostname, level numérique, time, msg).
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['@timestamp', 'event', 'log', 'message', 'service'].sort(),
    );
  });

  test('range les données de l’appel sous `scraper` et le nom d’événement dans event.action', () => {
    const { logger, lines } = captureLogger();

    logger.warn(
      { event: 'sync.game.failed', runId: 'r1', threadId: 42 },
      'échec',
    );

    expect(lines()[0]).toMatchObject({
      log: { level: 'warn' },
      event: { dataset: 'f95list-scraper', action: 'sync.game.failed' },
      scraper: { runId: 'r1', threadId: 42 },
    });
    //? `event` ne doit pas se retrouver deux fois (dans `scraper` et dans `event.action`).
    expect(lines()[0]?.scraper.event).toBeUndefined();
  });

  test('sérialise une erreur au format ECS `error.*`', () => {
    const { logger, lines } = captureLogger();

    logger.error({ err: new TypeError('boom') }, 'plantage');

    expect(lines()[0]?.error).toMatchObject({
      type: 'TypeError',
      message: 'boom',
    });
    expect(lines()[0]?.error.stack_trace).toContain('TypeError: boom');
    expect(lines()[0]?.scraper).toBeUndefined();
  });

  test('respecte le niveau configuré', () => {
    const { logger, lines } = captureLogger('warn');

    logger.info('ignoré');
    logger.warn('gardé');

    expect(lines().map((line) => line.message)).toEqual(['gardé']);
  });
});
