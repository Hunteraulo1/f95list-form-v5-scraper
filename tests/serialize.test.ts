import { describe, expect, test } from 'bun:test';
import type { IndexerClient } from '../src/indexer/client.ts';
import { serializeFast } from '../src/indexer/serialize.ts';

const setup = (fast: IndexerClient['fast']) =>
  serializeFast({
    fast,
    full: async () => {
      throw new Error('inattendu');
    },
    raw: async () => {
      throw new Error('inattendu');
    },
  });

describe('serializeFast', () => {
  test('ne laisse jamais deux /fast en vol, même lancés en même temps', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const client = setup(async (ids) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(ids[0] ?? 0);
      await Bun.sleep(5);
      inFlight--;
      return new Map(ids.map((id) => [id, 1]));
    });

    await Promise.all([1, 2, 3, 4].map((id) => client.fast([id])));

    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('un /fast en échec ne bloque pas les suivants', async () => {
    let call = 0;
    const client = setup(async (ids) => {
      if (call++ === 0) throw new Error('timeout');
      return new Map(ids.map((id) => [id, 1]));
    });

    const [first, second] = await Promise.allSettled([
      client.fast([1]),
      client.fast([2]),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });
});
