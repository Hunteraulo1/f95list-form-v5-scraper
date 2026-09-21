import type { IndexerClient } from './client.ts';

/**
 * Force les appels `/fast` à passer un par un, quel que soit l'appelant (cycle, actualisation
 * manuelle, aperçu) : WillyJL interdit plusieurs `/fast` en parallèle. Les appels attendent leur
 * tour dans l'ordre d'arrivée, donc une actualisation manuelle s'intercale entre deux paquets
 * d'un cycle en cours au lieu d'attendre sa fin.
 */
export const serializeFast = (client: IndexerClient): IndexerClient => {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    ...client,
    fast(ids, signal) {
      const run = tail.then(() => client.fast(ids, signal));
      tail = run.catch(() => {});
      return run;
    },
  };
};
