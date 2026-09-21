import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Thread } from '../indexer/schemas.ts';
import { editionStatus } from '../mapping.ts';
import type { TrackedGame } from '../sync/cycle.ts';
import { toColumns } from './columns.ts';

//? Seule l'origine F95zone passe par l'API de F95Checker. Les autres sites viendront plus tard.
export const ORIGIN_NAME = 'F95zone';

/**
 * - `active` : jeux actifs avec au moins une traduction active, mis à jour toutes les 6 h ;
 * - `inactive` : les autres (jeu inactif, ou sans traduction active), une fois par jour suffit ;
 * - `all` : les deux.
 */
export type SyncScope = 'active' | 'inactive' | 'all';

export interface ApplyInput {
  threadId: number;
  lastChange: number;
  thread: Thread;
  /** Vrai pour un nouveau jeu, faux pour une actualisation (le nom est alors laissé tel quel). */
  updateName: boolean;
}

export interface ApplyResult {
  games: number;
  editions: number;
}

export interface GameRepository {
  /** Jeux F95zone en `autoCheck`, avec leur `last_change` connu. */
  listTracked(scope: SyncScope): Promise<TrackedGame[]>;
  findGame(
    gameId: number,
  ): Promise<{ id: number; threadId: number | null; origin: string } | null>;
  /** Écrit les données du thread sur le jeu et sur ses éditions en `autoCheck`. */
  applyThread(input: ApplyInput): Promise<ApplyResult>;
  /** Le timestamp n'a pas bougé : on note seulement que la vérification a eu lieu. */
  markChecked(threadIds: readonly number[]): Promise<void>;
}

//? Les tables appartiennent au projet principal (MikroORM). Ces requêtes ne doivent lire et écrire
//? que les colonnes citées ici ; toute migration se fait là-bas.
const IS_ACTIVE = `(g.active = 1 AND EXISTS (
  SELECT 1 FROM game_edition e
  JOIN game_translation t ON t.game_edition_id = e.id
  WHERE e.game_id = g.id AND e.active = 1 AND t.active = 1
))`;

export const createGameRepository = (pool: Pool): GameRepository => ({
  async listTracked(scope) {
    const scopeFilter = {
      active: `AND ${IS_ACTIVE}`,
      inactive: `AND NOT ${IS_ACTIVE}`,
      all: '',
    }[scope];

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT g.thread_id AS id, g.last_change AS lastChange
       FROM game g
       JOIN \`origin-website\` o ON o.id = g.website
       WHERE o.name = ? AND g.auto_check = 1 AND g.thread_id IS NOT NULL
       ${scopeFilter}
       ORDER BY g.thread_id`,
      [ORIGIN_NAME],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      lastChange: row.lastChange === null ? null : Number(row.lastChange),
    }));
  },

  async findGame(gameId) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT g.id, g.thread_id AS threadId, o.name AS origin
       FROM game g JOIN \`origin-website\` o ON o.id = g.website
       WHERE g.id = ?`,
      [gameId],
    );
    const row = rows[0];
    return row
      ? {
          id: Number(row.id),
          threadId: row.threadId === null ? null : Number(row.threadId),
          origin: String(row.origin),
        }
      : null;
  },

  async applyThread({ threadId, lastChange, thread, updateName }) {
    const { game, edition } = toColumns(thread);
    const status = editionStatus(thread.status);
    const name = updateName && thread.name !== '' ? thread.name : null;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      //? COALESCE : une valeur vide côté API conserve celle de la base. `score` et `votes` sont
      //? écrits tels quels (voir `toColumns`). `last_updated` est calculé en UTC, quel que soit le
      //? fuseau de la session MariaDB.
      const [games] = await connection.execute<ResultSetHeader>(
        `UPDATE game g
         JOIN \`origin-website\` o ON o.id = g.website
         SET g.last_change = ?,
             g.description = COALESCE(?, g.description),
             g.image_external = COALESCE(?, g.image_external),
             g.name = COALESCE(?, g.name),
             g.developer = COALESCE(?, g.developer),
             g.last_updated = COALESCE(DATE_ADD('1970-01-01 00:00:00', INTERVAL ? SECOND), g.last_updated),
             g.score = ?,
             g.votes = ?,
             g.downloads = COALESCE(?, g.downloads),
             g.reviews = COALESCE(?, g.reviews)
         WHERE g.thread_id = ? AND o.name = ?`,
        [
          lastChange,
          game.description,
          game.imageExternal,
          name,
          game.developer,
          game.lastUpdated,
          game.score,
          game.votes,
          game.downloads,
          game.reviews,
          threadId,
          ORIGIN_NAME,
        ],
      );

      const [editions] = await connection.execute<ResultSetHeader>(
        `UPDATE game_edition e
         JOIN game g ON g.id = e.game_id
         JOIN \`origin-website\` o ON o.id = g.website
         SET e.version = COALESCE(?, e.version),
             e.status = COALESCE(?, e.status),
             e.last_auto_check = NOW()
         WHERE g.thread_id = ? AND o.name = ? AND e.auto_check = 1 AND e.active = 1`,
        [edition.version, status, threadId, ORIGIN_NAME],
      );

      await connection.commit();
      return { games: games.affectedRows, editions: editions.affectedRows };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async markChecked(threadIds) {
    if (threadIds.length === 0) return;
    await pool.query(
      `UPDATE game_edition e
       JOIN game g ON g.id = e.game_id
       JOIN \`origin-website\` o ON o.id = g.website
       SET e.last_auto_check = NOW()
       WHERE g.thread_id IN (?) AND o.name = ? AND e.auto_check = 1 AND e.active = 1`,
      [threadIds, ORIGIN_NAME],
    );
  },
});
