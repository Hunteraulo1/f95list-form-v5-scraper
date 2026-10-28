import type { IndexerClient } from '../indexer/client.ts';
import type { Thread } from '../indexer/schemas.ts';
import { type ThreadStatus, threadStatus } from '../mapping.ts';
import { type FailureKind, runSync, type TrackedGame } from './cycle.ts';

export type CheckResult =
  | {
      id: number;
      result: 'changed';
      lastChange: number;
      //? Libellé de `thread.status`, `null` si l'API renvoie un statut inconnu.
      status: ThreadStatus | null;
      thread: Thread;
    }
  //? `lastChange` est celui fourni par l'appelant : rien n'a bougé depuis.
  | { id: number; result: 'unchanged'; lastChange: number }
  //? Thread supprimé, privé ou déplacé : c'est à l'appelant de décider quoi en faire.
  | { id: number; result: 'not_found' }
  | { id: number; result: 'failed'; kind: FailureKind; message: string };

/**
 * Vérifie un lot de threads sans rien écrire : même flux que le cycle de synchro (`/fast` puis
 * `/full` pour les timestamps qui ont bougé), mais les résultats sont renvoyés à l'appelant, qui
 * stocke lui-même `lastChange`. Un `lastChange` nul force `/full`. Les résultats suivent l'ordre
 * des ids reçus, doublons retirés.
 */
export const checkThreads = async (
  threads: readonly TrackedGame[],
  {
    client,
    fullConcurrency,
    signal,
  }: { client: IndexerClient; fullConcurrency: number; signal?: AbortSignal },
): Promise<CheckResult[]> => {
  const known = new Map(threads.map((t) => [t.id, t.lastChange]));
  const results = new Map<number, CheckResult>();

  await runSync(threads, {
    client,
    fullConcurrency,
    signal,
    sink: {
      onUpdate({ id, lastChange, thread }) {
        //? Toujours renseigné ici : `lastChange` n'est nul qu'avec la source `raw`.
        if (lastChange === null) return;
        results.set(id, {
          id,
          result: 'changed',
          lastChange,
          status: threadStatus(thread.status),
          thread,
        });
      },
      onUnchanged(ids) {
        for (const id of ids) {
          results.set(id, {
            id,
            result: 'unchanged',
            lastChange: known.get(id) ?? 0,
          });
        }
      },
      onNotFound({ id }) {
        results.set(id, { id, result: 'not_found' });
      },
      onFailure({ id, kind, message }) {
        results.set(id, { id, result: 'failed', kind, message });
      },
    },
  });

  return [...known.keys()].map(
    (id) =>
      results.get(id) ?? {
        id,
        result: 'failed',
        kind: 'aborted',
        message: 'Vérification interrompue',
      },
  );
};
