import type { GameRepository } from '../db/games.ts';
import type { Logger } from '../logger.ts';
import type { SyncSink } from './cycle.ts';

//? Ces échecs signalent un bug de notre côté ou un changement de l'API : ils méritent une alerte.
//? Les autres (réseau, timeout, HTTP) sont attendus de temps en temps et se réessaient au prochain cycle.
const ALERTING_KINDS = new Set(['bad_request', 'invalid_response']);

//? Cycle automatique : le nom du jeu n'est jamais modifié (seule l'actualisation d'un nouveau jeu
//? le fait, voir `refreshGame`). Chaque log porte le `runId` du cycle pour tout retrouver dans Kibana.
export const createDbSink = (
  repository: GameRepository,
  logger: Logger,
  runId: string,
): SyncSink => ({
  async onUpdate({ id, lastChange, thread }) {
    const result = await repository.applyThread({
      threadId: id,
      lastChange,
      thread,
      updateName: false,
    });
    logger.info(
      {
        event: 'sync.game.updated',
        runId,
        threadId: id,
        lastChange,
        version: thread.version,
        apiStatus: thread.status,
        ...result,
      },
      `jeu ${id} mis à jour`,
    );
  },
  async onUnchanged(threadIds) {
    await repository.markChecked(threadIds);
  },
  onNotFound({ id, lastChange }) {
    //? Politique à définir (archiver, ignorer, alerter) : pour l'instant on journalise seulement.
    logger.warn(
      { event: 'sync.game.not_found', runId, threadId: id, lastChange },
      `thread ${id} introuvable`,
    );
  },
  onFailure({ id, kind, message }) {
    logger[ALERTING_KINDS.has(kind) ? 'error' : 'warn'](
      { event: 'sync.game.failed', runId, threadId: id, kind, reason: message },
      `échec de synchro du thread ${id} (${kind})`,
    );
  },
});
