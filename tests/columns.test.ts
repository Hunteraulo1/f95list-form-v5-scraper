import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { toColumns } from '../src/db/columns.ts';
import { threadSchema } from '../src/indexer/schemas.ts';
import { fixture } from './helpers.ts';

const gameThread = v.parse(threadSchema, fixture('full-game'));
const emptyThread = v.parse(threadSchema, fixture('full-empty-thread'));

describe('toColumns', () => {
  test('convertit un vrai jeu', () => {
    const { game, edition } = toColumns(gameThread);

    expect(game).toMatchObject({
      developer: 'Arkham',
      lastUpdated: 1641855600,
      score: 3.2,
      votes: 6,
      imageExternal: 'https://attachments.f95zone.to/2016/10/14655_29441.jpg',
    });
    expect(JSON.parse(game.reviews ?? 'null')).toHaveLength(6);
    expect(edition.version).toBe('Arkham');
  });

  test('écarte les liens XPath hérités et les plateformes qui n’ont plus de lien', () => {
    const { game } = toColumns({
      ...gameThread,
      downloads: [
        {
          platform: 'Win',
          links: [
            {
              host: 'MIXDROP',
              url: "//a[starts-with(@href,'https://mixdrop.ag/')][1]",
            },
            { host: 'MEGA', url: 'https://f95zone.to/masked/mega.nz/1/2' },
          ],
        },
        {
          platform: 'Mac',
          links: [{ host: 'ZIPPY', url: '//a[starts-with(@href,"x")][1]' }],
        },
      ],
    });

    expect(JSON.parse(game.downloads ?? 'null')).toEqual([
      {
        platform: 'Win',
        links: [{ host: 'MEGA', url: 'https://f95zone.to/masked/mega.nz/1/2' }],
      },
    ]);
  });

  test('un jeu dont tous les liens sont des XPath (cas réel de nos échantillons) ne touche pas aux downloads', () => {
    expect(toColumns(gameThread).game.downloads).toBeNull();
  });

  test('des valeurs vides donnent null, pour conserver celles de la base', () => {
    const { game, edition } = toColumns(emptyThread);

    expect(game).toMatchObject({
      description: null,
      imageExternal: null,
      developer: null,
      downloads: null,
      reviews: null,
    });
    expect(edition.version).toBeNull();
  });

  test('sans vote, le score est effacé plutôt que d’afficher 0', () => {
    expect(toColumns(emptyThread).game).toMatchObject({
      score: null,
      votes: 0,
    });
    expect(
      toColumns({ ...gameThread, votes: 0, score: 0 }).game.score,
    ).toBeNull();
  });

  test('une date à 0 est une date inconnue', () => {
    expect(
      toColumns({ ...gameThread, lastUpdated: 0 }).game.lastUpdated,
    ).toBeNull();
  });

  test('tronque la version à 36 caractères', () => {
    expect(
      toColumns({ ...gameThread, version: 'v'.repeat(80) }).edition.version,
    ).toBe('v'.repeat(36));
  });
});
