import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import * as v from 'valibot';
import { createGameRepository } from '../src/db/games.ts';
import { createPool } from '../src/db/pool.ts';
import { threadSchema } from '../src/indexer/schemas.ts';
import { fixture } from './helpers.ts';

//? Test d'intégration : il a besoin d'une vraie MariaDB, et il DÉTRUIT les tables `game*` et
//? `origin-website` de la base visée. Ne jamais le pointer vers une base qui contient des données.
//?   TEST_DATABASE_URL=mysql://root:root@localhost:3306/f95scraper_test bun test
const url = process.env.TEST_DATABASE_URL;

//? Schéma minimal : uniquement les colonnes lues ou écrites par le scraper. La source de vérité
//? reste `entities.ts` dans f95list-form-v5.
const SCHEMA = [
  'DROP TABLE IF EXISTS game_translation',
  'DROP TABLE IF EXISTS game_edition',
  'DROP TABLE IF EXISTS game',
  'DROP TABLE IF EXISTS `origin-website`',
  'CREATE TABLE `origin-website` (id char(36) PRIMARY KEY, name varchar(32) NOT NULL)',
  `CREATE TABLE game (
    id mediumint unsigned PRIMARY KEY AUTO_INCREMENT,
    name varchar(255) NOT NULL,
    website char(36) NOT NULL,
    thread_id mediumint unsigned NULL,
    last_change int unsigned NULL,
    image_external varchar(2048) NULL,
    description text NULL,
    developer varchar(255) NULL,
    last_updated datetime NULL,
    score decimal(3,2) NULL,
    votes int unsigned NULL,
    downloads json NULL,
    reviews json NULL,
    auto_check tinyint(1) NOT NULL,
    active tinyint(1) NOT NULL
  )`,
  `CREATE TABLE game_edition (
    id char(36) PRIMARY KEY,
    game_id mediumint unsigned NOT NULL,
    version varchar(36) NOT NULL,
    status enum('in_progress','completed','abandoned','on_hold') NOT NULL,
    auto_check tinyint(1) NOT NULL,
    last_auto_check datetime NULL,
    active tinyint(1) NOT NULL
  )`,
  `CREATE TABLE game_translation (
    id char(36) PRIMARY KEY,
    game_edition_id char(36) NOT NULL,
    active tinyint(1) NOT NULL
  )`,
];

const gameThread = v.parse(threadSchema, fixture('full-game'));

describe.skipIf(!url)('createGameRepository (MariaDB)', () => {
  const pool = createPool(url ?? '');
  const repository = createGameRepository(pool);

  const insertGame = async (
    id: number,
    row: {
      origin?: string;
      threadId?: number | null;
      autoCheck?: boolean;
      active?: boolean;
      lastChange?: number | null;
      name?: string;
    } = {},
  ) => {
    await pool.execute(
      `INSERT INTO game (id, name, website, thread_id, last_change, description, image_external, auto_check, active)
       VALUES (?, ?, ?, ?, ?, 'ancienne description', 'ancienne-image', ?, ?)`,
      [
        id,
        row.name ?? `Jeu ${id}`,
        row.origin ?? 'o-f95',
        row.threadId === undefined ? id * 10 : row.threadId,
        row.lastChange ?? null,
        row.autoCheck === false ? 0 : 1,
        row.active === false ? 0 : 1,
      ],
    );
  };

  const insertEdition = async (
    id: string,
    gameId: number,
    row: {
      autoCheck?: boolean;
      active?: boolean;
      translation?: boolean | null;
    } = {},
  ) => {
    await pool.execute(
      `INSERT INTO game_edition (id, game_id, version, status, auto_check, active)
       VALUES (?, ?, 'v0.1', 'in_progress', ?, ?)`,
      [
        id,
        gameId,
        row.autoCheck === false ? 0 : 1,
        row.active === false ? 0 : 1,
      ],
    );
    if (row.translation !== undefined && row.translation !== null) {
      await pool.execute(
        'INSERT INTO game_translation (id, game_edition_id, active) VALUES (?, ?, ?)',
        [`t-${id}`, id, row.translation ? 1 : 0],
      );
    }
  };

  //? Selon le pilote, une colonne JSON revient décodée ou en texte.
  const asJson = (value: unknown) =>
    typeof value === 'string' ? JSON.parse(value) : value;

  const one = async (sql: string, params: unknown[] = []) => {
    const [rows] = await pool.query(sql, params);
    return (rows as Record<string, unknown>[])[0] ?? {};
  };

  beforeAll(async () => {
    for (const statement of SCHEMA) await pool.query(statement);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM game_translation');
    await pool.query('DELETE FROM game_edition');
    await pool.query('DELETE FROM game');
    await pool.query('DELETE FROM `origin-website`');
    await pool.query(
      "INSERT INTO `origin-website` (id, name) VALUES ('o-f95', 'F95zone'), ('o-lc', 'LewdCorner')",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('listTracked', () => {
    beforeEach(async () => {
      await insertGame(1, { lastChange: 500 }); // traduction active
      await insertEdition('e1', 1, { translation: true });
      await insertGame(2); // aucune traduction
      await insertEdition('e2', 2);
      await insertGame(3); // traduction seulement inactive
      await insertEdition('e3', 3, { translation: false });
      await insertGame(4, { autoCheck: false }); // pas d'autoCheck
      await insertGame(5, { origin: 'o-lc' }); // autre origine
      await insertGame(6, { threadId: null }); // pas de thread
      await insertGame(7, { active: false }); // jeu inactif, malgré une traduction active
      await insertEdition('e7', 7, { translation: true });
      await insertGame(8); // traduction active sur une édition inactive
      await insertEdition('e8', 8, { active: false, translation: true });
    });

    test('active : seulement les jeux F95zone actifs avec une traduction active', async () => {
      expect(await repository.listTracked('active')).toEqual([
        { id: 10, lastChange: 500 },
      ]);
    });

    test('inactive : jeu inactif, sans traduction ou sans traduction active', async () => {
      expect(await repository.listTracked('inactive')).toEqual([
        { id: 20, lastChange: null },
        { id: 30, lastChange: null },
        { id: 70, lastChange: null },
        { id: 80, lastChange: null },
      ]);
    });

    test('all : la réunion des deux, sans les autres origines ni les threads nuls', async () => {
      const ids = (await repository.listTracked('all')).map((game) => game.id);
      expect(ids).toEqual([10, 20, 30, 70, 80]);
    });
  });

  describe('findGame', () => {
    test('renvoie l’origine et le thread, ou null', async () => {
      await insertGame(1, { origin: 'o-lc', threadId: 42 });

      expect(await repository.findGame(1)).toEqual({
        id: 1,
        threadId: 42,
        origin: 'LewdCorner',
      });
      expect(await repository.findGame(99)).toBeNull();
    });
  });

  describe('applyThread', () => {
    beforeEach(async () => {
      await insertGame(1, { name: 'Nom corrigé à la main', threadId: 1000 });
      await insertEdition('auto', 1);
      await insertEdition('manuelle', 1, { autoCheck: false });
      await insertEdition('inactive', 1, { active: false });
      await insertGame(2, { threadId: 2000 }); // autre thread : ne doit pas bouger
      await insertEdition('autre', 2);
      await insertGame(3, { threadId: 1000, origin: 'o-lc' }); // même id, autre origine
      await pool.query(
        `UPDATE game SET developer = 'Ancien dev', last_updated = '2020-01-01 00:00:00',
           score = 1.5, votes = 2, downloads = '[{"platform":"Win","links":[]}]', reviews = '[]'`,
      );
    });

    const apply = (
      overrides: Partial<Parameters<typeof repository.applyThread>[0]> = {},
    ) =>
      repository.applyThread({
        threadId: 1000,
        lastChange: 1782662170,
        thread: gameThread,
        updateName: false,
        ...overrides,
      });

    test('met à jour le jeu et ses éditions en autoCheck, sans toucher au nom', async () => {
      const result = await apply();

      expect(result).toEqual({ games: 1, editions: 1 });
      expect(await one('SELECT * FROM game WHERE id = 1')).toMatchObject({
        name: 'Nom corrigé à la main',
        last_change: 1782662170,
        description: gameThread.description,
        image_external: gameThread.imageUrl,
      });
      expect(
        await one("SELECT * FROM game_edition WHERE id = 'auto'"),
      ).toMatchObject({
        version: 'Arkham',
        status: 'completed',
      });
      expect(
        (
          await one(
            "SELECT last_auto_check FROM game_edition WHERE id = 'auto'",
          )
        ).last_auto_check,
      ).not.toBeNull();
    });

    test('écrit les données F95Checker : développeur, date en UTC, score, votes, avis', async () => {
      await apply();

      const row = await one(
        "SELECT developer, DATE_FORMAT(last_updated, '%Y-%m-%d %H:%i:%s') AS last_updated, score, votes, reviews FROM game WHERE id = 1",
      );
      expect(row).toMatchObject({
        developer: 'Arkham',
        //? 1641855600 = 2022-01-10 23:00:00 UTC, quel que soit le fuseau de la session MariaDB.
        last_updated: '2022-01-10 23:00:00',
        votes: 6,
      });
      expect(Number(row.score)).toBeCloseTo(3.2);
      expect(asJson(row.reviews)).toHaveLength(6);
    });

    test('la date reste en UTC même si la session MariaDB est dans un autre fuseau', async () => {
      await pool.query("SET GLOBAL time_zone = '+09:00'");
      try {
        const other = createPool(url ?? '');
        try {
          await createGameRepository(other).applyThread({
            threadId: 1000,
            lastChange: 1,
            thread: gameThread,
            updateName: false,
          });
        } finally {
          await other.end();
        }
        expect(
          (
            await one(
              "SELECT DATE_FORMAT(last_updated, '%H:%i') AS h FROM game WHERE id = 1",
            )
          ).h,
        ).toBe('23:00');
      } finally {
        await pool.query("SET GLOBAL time_zone = 'SYSTEM'");
      }
    });

    test('écrit les liens de téléchargement utilisables en JSON', async () => {
      await apply({
        thread: {
          ...gameThread,
          downloads: [
            {
              platform: 'Win',
              links: [
                { host: 'MEGA', url: 'https://f95zone.to/masked/mega.nz/1' },
              ],
            },
          ],
        },
      });

      expect(
        asJson(
          (await one('SELECT downloads FROM game WHERE id = 1')).downloads,
        ),
      ).toEqual([
        {
          platform: 'Win',
          links: [{ host: 'MEGA', url: 'https://f95zone.to/masked/mega.nz/1' }],
        },
      ]);
    });

    test('sans vote le score est effacé, et les valeurs vides conservent celles de la base', async () => {
      await apply({
        thread: {
          ...gameThread,
          votes: 0,
          score: 0,
          developer: null,
          downloads: [],
          reviews: [],
          lastUpdated: 0,
        },
      });

      const row = await one(
        "SELECT developer, DATE_FORMAT(last_updated, '%Y-%m-%d') AS last_updated, score, votes, downloads, reviews FROM game WHERE id = 1",
      );
      expect(row).toMatchObject({
        developer: 'Ancien dev',
        last_updated: '2020-01-01',
        score: null,
        votes: 0,
      });
      expect(asJson(row.downloads)).toEqual([{ platform: 'Win', links: [] }]);
      expect(asJson(row.reviews)).toEqual([]);
    });

    test('ne touche ni aux éditions sans autoCheck ou inactives, ni aux autres jeux', async () => {
      await apply();

      for (const id of ['manuelle', 'inactive', 'autre']) {
        expect(
          await one('SELECT * FROM game_edition WHERE id = ?', [id]),
        ).toMatchObject({
          version: 'v0.1',
          status: 'in_progress',
          last_auto_check: null,
        });
      }
      expect(await one('SELECT * FROM game WHERE id = 2')).toMatchObject({
        last_change: null,
        description: 'ancienne description',
      });
      //? Même thread_id mais autre origine : jamais mis à jour par l'API de F95Checker.
      expect(await one('SELECT * FROM game WHERE id = 3')).toMatchObject({
        last_change: null,
        description: 'ancienne description',
      });
    });

    test('updateName remplace le nom (nouveau jeu)', async () => {
      await apply({ updateName: true });

      expect((await one('SELECT name FROM game WHERE id = 1')).name).toBe(
        'Homeless School Girl',
      );
    });

    test('des valeurs vides ou inconnues côté API conservent celles de la base', async () => {
      await apply({
        thread: {
          ...gameThread,
          description: '',
          imageUrl: null,
          version: null,
          status: 5,
        },
        updateName: true,
      });

      expect(await one('SELECT * FROM game WHERE id = 1')).toMatchObject({
        description: 'ancienne description',
        image_external: 'ancienne-image',
        last_change: 1782662170,
      });
      expect(
        await one("SELECT * FROM game_edition WHERE id = 'auto'"),
      ).toMatchObject({
        version: 'v0.1',
        status: 'in_progress',
      });
    });

    test('tronque une version plus longue que la colonne (36)', async () => {
      await apply({ thread: { ...gameThread, version: 'v'.repeat(80) } });

      expect(
        (await one("SELECT version FROM game_edition WHERE id = 'auto'"))
          .version,
      ).toBe('v'.repeat(36));
    });

    test('annule tout si une écriture échoue', async () => {
      await pool.query(
        "ALTER TABLE game_edition ADD CONSTRAINT no_v CHECK (version <> 'Arkham')",
      );
      try {
        await expect(apply()).rejects.toThrow();
        expect(
          (await one('SELECT last_change FROM game WHERE id = 1')).last_change,
        ).toBeNull();
      } finally {
        await pool.query('ALTER TABLE game_edition DROP CONSTRAINT no_v');
      }
    });
  });

  describe('markChecked', () => {
    test('date la vérification des éditions en autoCheck des jeux F95zone concernés', async () => {
      await insertGame(1, { threadId: 1000 });
      await insertEdition('auto', 1);
      await insertEdition('manuelle', 1, { autoCheck: false });
      await insertGame(2, { threadId: 2000 });
      await insertEdition('autre', 2);

      await repository.markChecked([1000]);
      await repository.markChecked([]);

      const dates = async (id: string) =>
        (
          await one('SELECT last_auto_check FROM game_edition WHERE id = ?', [
            id,
          ])
        ).last_auto_check;
      expect(await dates('auto')).not.toBeNull();
      expect(await dates('manuelle')).toBeNull();
      expect(await dates('autre')).toBeNull();
    });
  });
});
