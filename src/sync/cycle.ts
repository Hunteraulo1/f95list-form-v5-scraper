import {
  FAST_MAX_IDS,
  type IndexerClient,
  IndexerError,
  type IndexerErrorKind,
} from '../indexer/client.ts';
import type { Thread } from '../indexer/schemas.ts';

/** Jeu suivi côté projet principal. `lastChange` est nul tant qu'il n'a jamais été synchronisé. */
export interface TrackedGame {
  id: number;
  lastChange: number | null;
}

export type FailureKind = IndexerErrorKind | 'invalid_timestamp' | 'aborted';

/**
 * Destination des résultats. Le cycle ne connaît ni la base ni le projet principal : c'est au
 * consommateur de persister `lastChange` avec les données.
 */
export interface SyncSink {
  /** Le timestamp a bougé et `/full` a répondu. */
  onUpdate(update: {
    id: number;
    lastChange: number;
    thread: Thread;
  }): void | Promise<void>;
  /** Le timestamp n'a pas bougé : rien à écrire, mais la vérification a bien eu lieu. */
  onUnchanged(threadIds: number[]): void | Promise<void>;
  /** `/full` répond `THREAD_MISSING` : politique à définir côté principal (archiver, ignorer…). */
  onNotFound(gone: { id: number; lastChange: number }): void | Promise<void>;
  onFailure(failure: {
    id: number;
    kind: FailureKind;
    message: string;
  }): void | Promise<void>;
}

export interface SyncProgress {
  total: number;
  /** Ids dont le timestamp a été vérifié par `/fast`. */
  checked: number;
  /** Ids dont le timestamp a changé (`/full` nécessaire). */
  changed: number;
  /** `/full` terminés, quel qu'en soit le résultat. */
  fullDone: number;
}

export interface SyncReport extends SyncProgress {
  updated: number;
  unchanged: number;
  notFound: number;
  failed: number;
  aborted: boolean;
  durationMs: number;
}

export interface SyncOptions {
  client: IndexerClient;
  sink: SyncSink;
  /** Parallélisme des `/full`. `/fast` reste strictement séquentiel quoi qu'il arrive. */
  fullConcurrency: number;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  now?: () => number;
}

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

//? Limiteur minimal : évite d'ajouter une dépendance pour une file de promesses.
const createLimiter = (concurrency: number) => {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (active >= concurrency) return;
    queue.shift()?.();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
};

const failureOf = (error: unknown): { kind: FailureKind; message: string } =>
  error instanceof IndexerError
    ? { kind: error.kind, message: error.message }
    : { kind: 'network', message: String(error) };

/**
 * Flux de F95Checker : `/fast` par paquets de 10, un à la fois, puis `/full` pour les jeux dont
 * le timestamp a bougé. Les `/full` démarrent dès qu'un paquet `/fast` est terminé, pendant que
 * les paquets suivants continuent.
 */
export const runSync = async (
  games: readonly TrackedGame[],
  {
    client,
    sink,
    fullConcurrency,
    signal,
    onProgress,
    now = Date.now,
  }: SyncOptions,
): Promise<SyncReport> => {
  const startedAt = now();
  const lastChangeById = new Map(games.map((g) => [g.id, g.lastChange]));
  const progress: SyncProgress = {
    total: lastChangeById.size,
    checked: 0,
    changed: 0,
    fullDone: 0,
  };
  const counters = { updated: 0, unchanged: 0, notFound: 0, failed: 0 };
  const limit = createLimiter(fullConcurrency);
  const fullTasks: Promise<void>[] = [];
  const emit = () => onProgress?.({ ...progress });

  const fail = async (id: number, kind: FailureKind, message: string) => {
    counters.failed++;
    await sink.onFailure({ id, kind, message });
  };

  const runFull = async (id: number, ts: number) => {
    try {
      if (signal?.aborted) return await fail(id, 'aborted', 'Cycle interrompu');
      const thread = await client.full(id, ts, signal);
      await sink.onUpdate({ id, lastChange: ts, thread });
      counters.updated++;
    } catch (error) {
      if (error instanceof IndexerError && error.kind === 'not_found') {
        counters.notFound++;
        await sink.onNotFound({ id, lastChange: ts });
      } else {
        const { kind, message } = failureOf(error);
        await fail(id, signal?.aborted ? 'aborted' : kind, message);
      }
    } finally {
      progress.fullDone++;
      emit();
    }
  };

  for (const ids of chunk([...lastChangeById.keys()], FAST_MAX_IDS)) {
    //? Séquentiel : on attend la réponse avant d'envoyer le paquet suivant.
    if (signal?.aborted) break;

    let timestamps: Map<number, number>;
    try {
      timestamps = await client.fast(ids, signal);
    } catch (error) {
      const { kind, message } = failureOf(error);
      for (const id of ids)
        await fail(id, signal?.aborted ? 'aborted' : kind, message);
      progress.checked += ids.length;
      emit();
      continue;
    }

    const unchanged: number[] = [];
    for (const id of ids) {
      const ts = timestamps.get(id);
      const known = lastChangeById.get(id) ?? null;

      if (ts === undefined || ts === 0) {
        await fail(
          id,
          'invalid_timestamp',
          `/fast n'a pas renvoyé de timestamp pour ${id}`,
        );
      } else if (known === null || ts > known) {
        progress.changed++;
        fullTasks.push(limit(() => runFull(id, ts)));
      } else {
        unchanged.push(id);
      }
    }
    if (unchanged.length > 0) {
      counters.unchanged += unchanged.length;
      await sink.onUnchanged(unchanged);
    }
    progress.checked += ids.length;
    emit();
  }

  await Promise.all(fullTasks);

  return {
    ...progress,
    ...counters,
    aborted: signal?.aborted ?? false,
    durationMs: now() - startedAt,
  };
};
