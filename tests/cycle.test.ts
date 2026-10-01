import { describe, expect, test } from 'bun:test';
import { type IndexerClient, IndexerError } from '../src/indexer/client.ts';
import type { Thread } from '../src/indexer/schemas.ts';
import { chunk, runSync, type SyncSink } from '../src/sync/cycle.ts';

const thread = (name: string) => ({ name }) as unknown as Thread;

const setup = (
  overrides: Partial<IndexerClient> & { fast?: IndexerClient['fast'] } = {},
) => {
  const events = {
    unchanged: [] as number[],
    updates: [] as number[],
    gone: [] as number[],
    failures: [] as string[],
  };
  const sink: SyncSink = {
    onUpdate: ({ id }) => void events.updates.push(id),
    onUnchanged: (ids) => void events.unchanged.push(...ids),
    onNotFound: ({ id }) => void events.gone.push(id),
    onFailure: ({ id, kind }) => void events.failures.push(`${id}:${kind}`),
  };
  const client: IndexerClient = {
    fast: async (ids) => new Map(ids.map((id) => [id, 100])),
    full: async (id) => thread(`jeu ${id}`),
    raw: async (id) => thread(`jeu ${id}`),
    ...overrides,
  };
  return { events, sink, client };
};

describe('chunk', () => {
  test('découpe par paquets, le dernier peut être plus court', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('runSync', () => {
  test('découpe en paquets de 10 et ne lance jamais deux /fast en même temps', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const { sink, client } = setup({
      fast: async (ids) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sizes.push(ids.length);
        await Bun.sleep(5);
        inFlight--;
        return new Map(ids.map((id) => [id, 100]));
      },
    });
    const games = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      lastChange: 100,
    }));

    const report = await runSync(games, { client, sink, fullConcurrency: 5 });

    expect(sizes).toEqual([10, 10, 5]);
    expect(maxInFlight).toBe(1);
    expect(report).toMatchObject({
      total: 25,
      checked: 25,
      changed: 0,
      updated: 0,
    });
  });

  test('ne demande /full que pour les timestamps qui ont augmenté ou les jeux jamais vus', async () => {
    const fullCalls: [number, number][] = [];
    const { events, sink, client } = setup({
      fast: async () =>
        new Map([
          [1, 200], // plus récent que connu
          [2, 100], // inchangé
          [3, 50], // plus ancien que connu : on ignore
          [4, 100], // jamais synchronisé
        ]),
      full: async (id, ts) => {
        fullCalls.push([id, ts]);
        return thread(`jeu ${id}`);
      },
    });

    const report = await runSync(
      [
        { id: 1, lastChange: 100 },
        { id: 2, lastChange: 100 },
        { id: 3, lastChange: 100 },
        { id: 4, lastChange: null },
      ],
      { client, sink, fullConcurrency: 5 },
    );

    expect(fullCalls.sort()).toEqual([
      [1, 200],
      [4, 100],
    ]);
    expect(events.updates.sort()).toEqual([1, 4]);
    //? Les jeux dont le timestamp n'a pas bougé sont signalés en un seul lot par paquet /fast.
    expect(events.unchanged.sort()).toEqual([2, 3]);
    expect(report).toMatchObject({
      changed: 2,
      updated: 2,
      unchanged: 2,
      failed: 0,
    });
  });

  test('respecte la limite de concurrence des /full', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { sink, client } = setup({
      full: async (id) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return thread(`jeu ${id}`);
      },
    });
    const games = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      lastChange: null,
    }));

    const report = await runSync(games, { client, sink, fullConcurrency: 3 });

    expect(maxInFlight).toBe(3);
    expect(report.updated).toBe(12);
  });

  test('un thread introuvable est signalé à part et ne compte pas comme un échec', async () => {
    const { events, sink, client } = setup({
      full: async (id) => {
        if (id === 2) throw new IndexerError('not_found', 'THREAD_MISSING');
        return thread(`jeu ${id}`);
      },
    });

    const report = await runSync(
      [1, 2, 3].map((id) => ({ id, lastChange: null })),
      { client, sink, fullConcurrency: 5 },
    );

    expect(events.gone).toEqual([2]);
    expect(report).toMatchObject({ updated: 2, notFound: 1, failed: 0 });
  });

  test('un /fast en échec marque son paquet en échec et passe au suivant', async () => {
    let call = 0;
    const { events, sink, client } = setup({
      fast: async (ids) => {
        if (call++ === 0) throw new IndexerError('network', 'timeout');
        return new Map(ids.map((id) => [id, 100]));
      },
    });
    const games = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      lastChange: null,
    }));

    const report = await runSync(games, { client, sink, fullConcurrency: 5 });

    expect(events.failures).toHaveLength(10);
    expect(events.failures[0]).toBe('1:network');
    expect(report).toMatchObject({ checked: 12, failed: 10, updated: 2 });
  });

  test('un timestamp absent ou nul est un échec invalid_timestamp', async () => {
    const { events, sink, client } = setup({
      fast: async () => new Map([[1, 0]]),
    });

    await runSync(
      [1, 2].map((id) => ({ id, lastChange: null })),
      { client, sink, fullConcurrency: 5 },
    );

    expect(events.failures.sort()).toEqual([
      '1:invalid_timestamp',
      '2:invalid_timestamp',
    ]);
  });

  test('un signal interrompu arrête avant les paquets suivants', async () => {
    const abort = new AbortController();
    const sizes: number[] = [];
    const { sink, client } = setup({
      fast: async (ids) => {
        sizes.push(ids.length);
        abort.abort();
        return new Map(ids.map((id) => [id, 100]));
      },
    });
    const games = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      lastChange: 100,
    }));

    const report = await runSync(games, {
      client,
      sink,
      fullConcurrency: 5,
      signal: abort.signal,
    });

    expect(sizes).toEqual([10]);
    expect(report.aborted).toBe(true);
  });

  test('dédoublonne les ids', async () => {
    const sizes: number[] = [];
    const { sink, client } = setup({
      fast: async (ids) => {
        sizes.push(ids.length);
        return new Map(ids.map((id) => [id, 100]));
      },
    });

    const report = await runSync(
      [
        { id: 1, lastChange: 100 },
        { id: 1, lastChange: 100 },
      ],
      { client, sink, fullConcurrency: 5 },
    );

    expect(sizes).toEqual([1]);
    expect(report.total).toBe(1);
  });

  describe('source raw', () => {
    test('n’appelle que /raw, en parallèle limité, sans timestamp', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const updates: (number | null)[] = [];
      const { sink, client } = setup({
        fast: async () => {
          throw new Error('/fast ne doit pas être appelé');
        },
        full: async () => {
          throw new Error('/full ne doit pas être appelé');
        },
        raw: async (id) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(5);
          inFlight--;
          return thread(`jeu ${id}`);
        },
      });
      sink.onUpdate = ({ lastChange }) => void updates.push(lastChange);
      const games = Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        lastChange: 100,
      }));

      const report = await runSync(games, {
        client,
        sink,
        fullConcurrency: 3,
        source: 'raw',
      });

      expect(maxInFlight).toBe(3);
      expect(updates).toEqual(Array(12).fill(null));
      expect(report).toMatchObject({
        total: 12,
        checked: 12,
        changed: 0,
        updated: 12,
        failed: 0,
      });
    });

    test('un jeu jamais synchronisé passe quand même par /fast puis /full', async () => {
      const calls: string[] = [];
      const updates: [number, number | null][] = [];
      const { sink, client } = setup({
        fast: async (ids) => {
          calls.push(`fast:${ids.join(',')}`);
          return new Map(ids.map((id) => [id, 300]));
        },
        full: async (id) => {
          calls.push(`full:${id}`);
          return thread(`jeu ${id}`);
        },
        raw: async (id) => {
          calls.push(`raw:${id}`);
          return thread(`jeu ${id}`);
        },
      });
      sink.onUpdate = ({ id, lastChange }) =>
        void updates.push([id, lastChange]);

      const report = await runSync(
        [
          { id: 1, lastChange: 100 },
          { id: 2, lastChange: null },
        ],
        { client, sink, fullConcurrency: 5, source: 'raw' },
      );

      expect(calls.sort()).toEqual(['fast:2', 'full:2', 'raw:1']);
      expect(updates.sort()).toEqual([
        [1, null],
        [2, 300],
      ]);
      expect(report).toMatchObject({ total: 2, checked: 2, updated: 2 });
    });

    test('un thread introuvable ou en échec est signalé comme en mode fast', async () => {
      const { events, sink, client } = setup({
        raw: async (id) => {
          if (id === 2) throw new IndexerError('not_found', 'THREAD_MISSING');
          if (id === 3) throw new IndexerError('network', 'timeout');
          return thread(`jeu ${id}`);
        },
      });

      const report = await runSync(
        [1, 2, 3].map((id) => ({ id, lastChange: 100 })),
        { client, sink, fullConcurrency: 5, source: 'raw' },
      );

      expect(events.gone).toEqual([2]);
      expect(events.failures).toEqual(['3:network']);
      expect(report).toMatchObject({ updated: 1, notFound: 1, failed: 1 });
    });

    test('un signal interrompu marque les jeux restants en aborted', async () => {
      const abort = new AbortController();
      const { events, sink, client } = setup({
        raw: async (id) => {
          abort.abort();
          return thread(`jeu ${id}`);
        },
      });

      const report = await runSync(
        [1, 2, 3].map((id) => ({ id, lastChange: 100 })),
        {
          client,
          sink,
          fullConcurrency: 1,
          source: 'raw',
          signal: abort.signal,
        },
      );

      expect(events.updates).toEqual([1]);
      expect(events.failures).toEqual(['2:aborted', '3:aborted']);
      expect(report.aborted).toBe(true);
    });
  });
});
