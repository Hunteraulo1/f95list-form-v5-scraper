import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.ts';
import {
  runSync,
  type SyncOptions,
  type SyncProgress,
  type SyncReport,
  type SyncSink,
  type TrackedGame,
} from './cycle.ts';

export type SyncStatus =
  | {
      state: 'idle';
      lastReport: SyncReport | null;
      lastError: string | null;
    }
  | {
      state: 'running';
      runId: string;
      scope: string;
      startedAt: number;
      progress: SyncProgress;
      lastReport: SyncReport | null;
    };

type RunOptions = Omit<SyncOptions, 'signal' | 'onProgress' | 'sink'> & {
  /** Un sink par cycle, pour que chaque log porte le `runId` du cycle. */
  sinkFor: (run: { runId: string }) => SyncSink;
};

//? `success` : rien à signaler. `partial` : au moins un jeu en échec ou introuvable.
//? `aborted` : arrêt demandé (redéploiement). `failed` : le cycle lui-même a planté.
export const outcomeOf = (
  report: Pick<SyncReport, 'failed' | 'notFound' | 'aborted'>,
) =>
  report.aborted
    ? 'aborted'
    : report.failed > 0 || report.notFound > 0
      ? 'partial'
      : 'success';

/**
 * Garantit un seul cycle à la fois, donc jamais deux `/fast` en parallèle (contrainte de WillyJL).
 * Le verrou est en mémoire : le service doit tourner en une seule instance.
 */
export const createSyncController = (options: RunOptions, logger: Logger) => {
  let running: {
    runId: string;
    scope: string;
    startedAt: number;
    progress: SyncProgress;
    abort: AbortController;
    done: Promise<void>;
  } | null = null;
  let lastReport: SyncReport | null = null;
  let lastError: string | null = null;

  return {
    /** `false` si un cycle est déjà en cours. */
    start(
      games: readonly TrackedGame[],
      { scope }: { scope: string },
    ): boolean {
      if (running) return false;

      const runId = randomUUID();
      const abort = new AbortController();
      const state = {
        runId,
        scope,
        startedAt: Date.now(),
        progress: { total: games.length, checked: 0, changed: 0, fullDone: 0 },
        abort,
        done: Promise.resolve(),
      };
      running = state;
      lastError = null;
      logger.info(
        { event: 'sync.started', runId, scope, total: games.length },
        'cycle démarré',
      );

      const { sinkFor, ...syncOptions } = options;
      state.done = runSync(games, {
        ...syncOptions,
        sink: sinkFor({ runId }),
        signal: abort.signal,
        onProgress: (progress) => {
          state.progress = progress;
        },
      })
        .then((report) => {
          lastReport = report;
          const outcome = outcomeOf(report);
          logger[outcome === 'success' ? 'info' : 'warn'](
            { event: 'sync.finished', runId, scope, outcome, ...report },
            `cycle terminé (${outcome})`,
          );
        })
        .catch((error) => {
          lastError = String(error);
          logger.error(
            {
              event: 'sync.finished',
              runId,
              scope,
              outcome: 'failed',
              err: error,
            },
            'cycle interrompu par une erreur',
          );
        })
        .finally(() => {
          running = null;
        });
      return true;
    },

    status(): SyncStatus {
      return running
        ? {
            state: 'running',
            runId: running.runId,
            scope: running.scope,
            startedAt: running.startedAt,
            progress: running.progress,
            lastReport,
          }
        : { state: 'idle', lastReport, lastError };
    },

    /** Attend la fin du cycle en cours, sans l'interrompre. */
    async whenIdle() {
      await running?.done;
    },

    /** Arrêt propre (SIGTERM au redéploiement) : interrompt le cycle puis attend qu'il se termine. */
    async stop() {
      running?.abort.abort();
      await running?.done;
    },
  };
};

export type SyncController = ReturnType<typeof createSyncController>;
