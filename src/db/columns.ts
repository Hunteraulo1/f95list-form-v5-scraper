import type { Thread } from '../indexer/schemas.ts';

//? `game_edition.version` est un varchar(36) : une valeur plus longue ferait échouer l'écriture.
const VERSION_MAX_LENGTH = 36;

//? Les liens de téléchargement de l'API sont parfois des XPath hérités
//? (`//a[starts-with(@href,'https://…')][1]`) : ce ne sont pas des liens utilisables.
const isUsableLink = (url: string) => !url.startsWith('//');

const usableDownloads = (downloads: Thread['downloads']) =>
  downloads
    .map(({ platform, links }) => ({
      platform,
      links: links.filter(({ url }) => isUsableLink(url)),
    }))
    .filter(({ links }) => links.length > 0);

/**
 * Valeurs à écrire pour un thread. `null` signifie « ne pas toucher à la colonne » (l'écriture SQL
 * utilise COALESCE) : une valeur vide côté API ne doit jamais effacer ce qu'on a déjà. Seuls `score`
 * et `votes` sont écrits tels quels, car 0 vote est un état réel et non une donnée manquante.
 */
export const toColumns = (thread: Thread) => {
  const downloads = usableDownloads(thread.downloads);
  return {
    game: {
      description: thread.description === '' ? null : thread.description,
      imageExternal: thread.imageUrl,
      developer: thread.developer,
      //? Unix en secondes, converti en UTC par le SQL. 0 = date inconnue.
      lastUpdated: thread.lastUpdated > 0 ? thread.lastUpdated : null,
      downloads: downloads.length > 0 ? JSON.stringify(downloads) : null,
      reviews:
        thread.reviews.length > 0 ? JSON.stringify(thread.reviews) : null,
      //? Sans vote, le score (0.0) n'a pas de sens : on l'efface plutôt que d'afficher « 0/5 ».
      score: thread.votes === 0 ? null : thread.score,
      votes: thread.votes,
    },
    edition: {
      version: thread.version?.slice(0, VERSION_MAX_LENGTH) ?? null,
    },
  };
};
