import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { GameRepository } from '../src/db/games.ts';
import { threadSchema } from '../src/indexer/schemas.ts';
import { createDbSink } from '../src/sync/db-sink.ts';
import { captureLogger, fixture } from './helpers.ts';

const setup = () => {
  const captured = captureLogger();
  const calls = { applied: [] as unknown[], checked: [] as number[][] };
  const repository: GameRepository = {
    listTracked: async () => [],
    findGame: async () => null,
    applyThread: async (input) => {
      calls.applied.push(input);
      return { games: 1, editions: 2 };
    },
    markChecked: async (ids) => {
      calls.checked.push([...ids]);
    },
  };
  return {
    sink: createDbSink(repository, captured.logger, 'run-1'),
    captured,
    calls,
  };
};

describe('createDbSink', () => {
  test('écrit en base sans jamais toucher au nom, et journalise la mise à jour', async () => {
    const { sink, captured, calls } = setup();
    const thread = v.parse(threadSchema, fixture('full-game'));

    await sink.onUpdate({ id: 1000, lastChange: 5, thread });

    expect(calls.applied[0]).toMatchObject({
      threadId: 1000,
      updateName: false,
    });
    expect(captured.events('sync.game.updated')[0]).toMatchObject({
      log: { level: 'info' },
      scraper: {
        runId: 'run-1',
        threadId: 1000,
        version: 'Arkham',
        apiStatus: 2,
        games: 1,
        editions: 2,
      },
    });
  });

  test('délègue les jeux inchangés au dépôt, sans log par jeu', async () => {
    const { sink, captured, calls } = setup();

    await sink.onUnchanged([1, 2, 3]);

    expect(calls.checked).toEqual([[1, 2, 3]]);
    expect(captured.lines()).toHaveLength(0);
  });

  test('un thread introuvable est un warn', () => {
    const { sink, captured } = setup();

    sink.onNotFound({ id: 9, lastChange: 4 });

    expect(captured.events('sync.game.not_found')[0]).toMatchObject({
      log: { level: 'warn' },
      scraper: { runId: 'run-1', threadId: 9 },
    });
  });

  test('une réponse invalide ou une mauvaise requête est une erreur, un échec réseau un warn', () => {
    const { sink, captured } = setup();

    sink.onFailure({ id: 1, kind: 'invalid_response', message: 'schéma' });
    sink.onFailure({ id: 2, kind: 'bad_request', message: 'ts' });
    sink.onFailure({ id: 3, kind: 'network', message: 'timeout' });
    sink.onFailure({ id: 4, kind: 'http', message: '503' });

    expect(
      captured
        .events('sync.game.failed')
        .map((l) => [l.scraper.threadId, l.log.level]),
    ).toEqual([
      [1, 'error'],
      [2, 'error'],
      [3, 'warn'],
      [4, 'warn'],
    ]);
  });
});
