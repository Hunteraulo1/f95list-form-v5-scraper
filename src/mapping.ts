export type ThreadStatus =
  | 'in_progress'
  | 'completed'
  | 'abandoned'
  | 'on_hold';

//? Identifiants de statut de l'API → libellé neutre, que f95-france convertit vers ses propres
//? statuts. 1, 2 et 4 sont vérifiés sur les données de f95list-form-v5 (24 jeux comparés le
//? 21/09/2026) ; 3 est déduit, aucun jeu `on_hold` n'était disponible pour le vérifier.
//? Tout autre identifiant (ex. « unchecked ») donne `null` : l'appelant conserve son statut.
const STATUSES: Readonly<Record<number, ThreadStatus>> = {
  1: 'in_progress',
  2: 'completed',
  3: 'on_hold',
  4: 'abandoned',
};

export const threadStatus = (apiStatus: number): ThreadStatus | null =>
  STATUSES[apiStatus] ?? null;
