import { type IndexerClient, IndexerError } from '../indexer/client.ts';
import type { Thread } from '../indexer/schemas.ts';

/**
 * Flux complet pour un seul thread : `/fast` pour connaître le timestamp actuel (ce qui déclenche
 * le réindexage si le cache est périmé), puis `/full` avec ce timestamp. Sert à l'actualisation
 * manuelle et à l'aperçu d'un nouveau jeu, où l'on veut la donnée fraîche sans comparer.
 */
export const fetchLatest = async (
  client: IndexerClient,
  threadId: number,
  signal?: AbortSignal,
): Promise<{ lastChange: number; thread: Thread }> => {
  const lastChange = (await client.fast([threadId], signal)).get(threadId);
  if (!lastChange) {
    throw new IndexerError(
      'invalid_response',
      `/fast n'a pas renvoyé de timestamp pour ${threadId}`,
    );
  }
  return {
    lastChange,
    thread: await client.full(threadId, lastChange, signal),
  };
};
