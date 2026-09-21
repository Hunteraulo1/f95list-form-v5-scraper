import * as v from 'valibot';

//? Les réponses de `/full` et `/raw` viennent de Redis : toutes les valeurs sont des chaînes.
//? Les nombres sont à convertir, les listes sont des chaînes JSON à décoder (voir docs/api.md).

const intString = v.pipe(
  v.string(),
  v.regex(/^-?\d+$/),
  v.transform(Number),
  v.integer(),
);

const floatString = v.pipe(
  v.string(),
  v.regex(/^-?\d+(\.\d+)?$/),
  v.transform(Number),
);

const jsonString = <const TSchema extends v.GenericSchema>(schema: TSchema) =>
  v.pipe(v.string(), v.parseJson(), schema);

/** `/fast?ids=` : `{ "<id>": <timestamp du dernier changement> }`. */
export const fastResponseSchema = v.record(
  v.pipe(v.string(), v.regex(/^\d+$/)),
  v.pipe(v.number(), v.integer(), v.minValue(0)),
);

/**
 * Corps commun aux réponses d'erreur (`404 THREAD_MISSING`) et aux réponses `200` d'un thread
 * indexé : `INDEX_ERROR` est vide quand tout s'est bien passé.
 */
export const indexEnvelopeSchema = v.object({ INDEX_ERROR: v.string() });

//? `[["<plateforme>", [["<hébergeur>", "<url>"], ...]], ...]`. La plateforme peut être vide.
//? Certaines URLs sont des XPath hérités (`//a[starts-with(@href,'https://…')][1]`) : elles ne
//? désignent pas un lien utilisable, F95Checker les résout en scrapant la page du thread.
const downloadsSchema = v.pipe(
  v.array(v.tuple([v.string(), v.array(v.tuple([v.string(), v.string()]))])),
  v.transform((platforms) =>
    platforms.map(([platform, links]) => ({
      platform,
      links: links.map(([host, url]) => ({ host, url })),
    })),
  ),
);

const reviewSchema = v.object({
  user: v.string(),
  score: v.number(),
  message: v.string(),
  likes: v.number(),
  timestamp: v.number(),
});

export const threadSchema = v.pipe(
  v.object({
    name: v.string(),
    version: v.string(),
    developer: v.string(),
    type: intString,
    status: intString,
    last_updated: intString,
    score: floatString,
    votes: intString,
    tags: jsonString(v.array(v.number())),
    //? Toujours vide dans nos échantillons : contenu non vérifié, donc laissé libre.
    unknown_tags: jsonString(v.array(v.unknown())),
    downloads: jsonString(downloadsSchema),
    previews_urls: jsonString(v.array(v.string())),
    reviews_total: intString,
    reviews: jsonString(v.array(reviewSchema)),
    image_url: v.string(),
    description: v.string(),
    changelog: v.string(),
    LAST_CACHED: intString,
  }),
  v.transform((raw) => ({
    name: raw.name,
    //? Une version vide est affichée « N/A » par F95Checker.
    version: raw.version === '' ? null : raw.version,
    developer: raw.developer === '' ? null : raw.developer,
    //? Identifiants numériques : le mapping vers des libellés n'est pas repris ici.
    type: raw.type,
    status: raw.status,
    tags: raw.tags,
    unknownTags: raw.unknown_tags,
    //? Unix, en secondes. Remplacé par la date du jour à chaque changement de version.
    lastUpdated: raw.last_updated,
    score: raw.score,
    votes: raw.votes,
    downloads: raw.downloads,
    //? `image_url` vaut « missing » quand le thread n'a pas d'image.
    imageUrl:
      raw.image_url === '' || raw.image_url === 'missing'
        ? null
        : raw.image_url,
    previewsUrls: raw.previews_urls,
    reviewsTotal: raw.reviews_total,
    reviews: raw.reviews,
    description: raw.description,
    changelog: raw.changelog,
    //? Unix, en secondes : dernière indexation par l'API.
    cachedAt: raw.LAST_CACHED,
  })),
);

export type Thread = v.InferOutput<typeof threadSchema>;
export type Download = Thread['downloads'][number];
export type Review = Thread['reviews'][number];
