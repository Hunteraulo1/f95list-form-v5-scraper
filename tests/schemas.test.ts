import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { threadSchema } from '../src/indexer/schemas.ts';
import { fixture } from './helpers.ts';

describe('threadSchema', () => {
  test('décode un vrai jeu (chaînes, listes JSON, sentinelles)', () => {
    const thread = v.parse(threadSchema, fixture('full-game'));

    expect(thread).toMatchObject({
      name: 'Homeless School Girl',
      version: 'Arkham',
      developer: 'Arkham',
      type: 9,
      status: 2,
      score: 3.2,
      votes: 6,
      reviewsTotal: 6,
      lastUpdated: 1641855600,
    });
    expect(thread.tags).toEqual([2, 39, 40, 54, 62, 68, 71, 91, 101, 108, 135]);
    expect(thread.imageUrl).toBe(
      'https://attachments.f95zone.to/2016/10/14655_29441.jpg',
    );
    expect(thread.reviews).toHaveLength(6);
    expect(thread.downloads[0]?.platform).toBe('Win');
    expect(thread.downloads[0]?.links[0]).toEqual({
      host: 'TORRENT',
      url: expect.stringContaining('//a[starts-with(@href'),
    });
  });

  test('un thread vide donne des valeurs nulles plutôt que des chaînes vides', () => {
    const thread = v.parse(threadSchema, fixture('full-empty-thread'));

    expect(thread.version).toBeNull();
    expect(thread.developer).toBeNull();
    //? « missing » est la valeur de l'API pour un thread sans image.
    expect(thread.imageUrl).toBeNull();
    expect(thread.tags).toEqual([]);
  });

  test('/raw a le même contrat que /full', () => {
    expect(() =>
      v.parse(threadSchema, fixture('raw-empty-thread')),
    ).not.toThrow();
  });

  test('rejette un thread dont une liste JSON est corrompue', () => {
    const broken = { ...(fixture('full-game') as object), tags: '[1, 2' };
    expect(v.safeParse(threadSchema, broken).success).toBe(false);
  });
});
