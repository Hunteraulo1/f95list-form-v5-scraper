import { describe, expect, test } from 'bun:test';
import type { IndexerClient } from '../src/indexer/client.ts';
import { createSyncController, outcomeOf } from '../src/sync/controller.ts';
import type { SyncSink } from '../src/sync/cycle.ts';
import { captureLogger } from './helpers.ts';

const setup = (client: Partial<IndexerClient> = {}) => {
  const captured = captureLogger();
  const runIds: string[] = [];
  const sink: SyncSink = {
    onUpdate() {},
    onUnchanged() {},
    onNotFound() {},
    onFailure() {},
  };
  const controller = createSyncController(
    {
      client: {
        fast: async (ids) => new Map(ids.map((id) => [id, 100])),
        full: async () => {
          throw new Error('inattendu');
        },
        raw: async () => {
          throw new Error('inattendu');
        },
        ...client,
      },
      fullConcurrency: 2,
      sinkFor: ({ runId }) => {
        runIds.push(runId);
        return sink;
      },
    },
    captured.logger,
  );
  return { controller, captured, runIds };
};

describe('outcomeOf', () => {
  test('success, partial ou aborted selon le rapport', () => {
    expect(outcomeOf({ failed: 0, notFound: 0, aborted: false })).toBe(
      'success',
    );
    expect(outcomeOf({ failed: 1, notFound: 0, aborted: false })).toBe(
      'partial',
    );
    expect(outcomeOf({ failed: 0, notFound: 2, aborted: false })).toBe(
      'partial',
    );
    expect(outcomeOf({ failed: 3, notFound: 0, aborted: true })).toBe(
      'aborted',
    );
  });
});

describe('createSyncController', () => {
  test('journalise le début et la fin du cycle avec le même runId', async () => {
    const { controller, captured, runIds } = setup();

    controller.start([{ id: 1, lastChange: 100 }], { scope: 'active' });
    await controller.whenIdle();

    const [started] = captured.events('sync.started');
    const [finished] = captured.events('sync.finished');
    expect(started?.scraper).toMatchObject({ scope: 'active', total: 1 });
    expect(finished?.scraper).toMatchObject({
      scope: 'active',
      outcome: 'success',
      unchanged: 1,
      failed: 0,
    });
    expect(finished?.log.level).toBe('info');
    expect(started?.scraper.runId).toBe(finished?.scraper.runId);
    expect(runIds).toEqual([started?.scraper.runId]);
  });

  test('un cycle avec des échecs est terminé en warn / partial', async () => {
    const { controller, captured } = setup({
      fast: async () => {
        throw new Error('timeout');
      },
    });

    controller.start([{ id: 1, lastChange: null }], { scope: 'all' });
    await controller.whenIdle();

    const [finished] = captured.events('sync.finished');
    expect(finished?.log.level).toBe('warn');
    expect(finished?.scraper).toMatchObject({ outcome: 'partial', failed: 1 });
  });

  test('un runId différent à chaque cycle, exposé dans /status', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, runIds } = setup({
      fast: async (ids) => {
        await gate;
        return new Map(ids.map((id) => [id, 100]));
      },
    });

    controller.start([{ id: 1, lastChange: 100 }], { scope: 'all' });
    const status = controller.status();
    expect(status.state).toBe('running');
    expect(status.state === 'running' ? status.runId : null).toBe(
      runIds[0] ?? null,
    );
    release();
    await controller.whenIdle();

    controller.start([{ id: 1, lastChange: 100 }], { scope: 'all' });
    await controller.whenIdle();
    expect(new Set(runIds).size).toBe(2);
  });
});
