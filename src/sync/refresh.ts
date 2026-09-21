import type { GameRepository } from '../db/games.ts';
import { ORIGIN_NAME } from '../db/games.ts';
import type { IndexerClient } from '../indexer/client.ts';
import type { Thread } from '../indexer/schemas.ts';
import { fetchLatest } from './latest.ts';

export type RefreshResult =
  | {
      ok: true;
      gameId: number;
      threadId: number;
      lastChange: number;
      nameUpdated: boolean;
      /** Lignes `game` et `game_edition` touchées. */
      games: number;
      editions: number;
      thread: Thread;
    }
  | {
      ok: false;
      reason: 'game_not_found' | 'unsupported_origin' | 'no_thread';
    };

/**
 * Actualisation manuelle d'un jeu, sans comparer au `last_change` connu. `updateName` est faux
 * pour un jeu existant (le nom a pu être corrigé à la main) et vrai pour un nouveau jeu.
 */
export const refreshGame = async (
  deps: { repository: GameRepository; client: IndexerClient },
  gameId: number,
  { updateName }: { updateName: boolean },
): Promise<RefreshResult> => {
  const game = await deps.repository.findGame(gameId);
  if (!game) return { ok: false, reason: 'game_not_found' };
  if (game.origin !== ORIGIN_NAME)
    return { ok: false, reason: 'unsupported_origin' };
  if (game.threadId === null) return { ok: false, reason: 'no_thread' };

  const { lastChange, thread } = await fetchLatest(deps.client, game.threadId);
  const result = await deps.repository.applyThread({
    threadId: game.threadId,
    lastChange,
    thread,
    updateName,
  });

  return {
    ok: true,
    gameId,
    threadId: game.threadId,
    lastChange,
    nameUpdated: updateName && thread.name !== '',
    ...result,
    thread,
  };
};
