export type EditionStatus =
  | 'in_progress'
  | 'completed'
  | 'abandoned'
  | 'on_hold';

//? Identifiants de statut de l'API → `game_edition.status`. 1, 2 et 4 sont vérifiés sur nos
//? données (24 jeux comparés le 21/09/2026) ; 3 est déduit, la base ne contient aucun jeu `on_hold`.
//? Tout autre identifiant (ex. « unchecked ») donne `null` : le statut en base est alors conservé.
const STATUSES: Readonly<Record<number, EditionStatus>> = {
  1: 'in_progress',
  2: 'completed',
  3: 'on_hold',
  4: 'abandoned',
};

export const editionStatus = (apiStatus: number): EditionStatus | null =>
  STATUSES[apiStatus] ?? null;
