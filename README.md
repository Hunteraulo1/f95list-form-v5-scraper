# f95list-form-v5-scraper — branche `v4`

Variante du scraper pour **[f95-france](https://github.com/Hunteraulo1/f95-france)** (v4). F95zone bloque désormais les accès directs (Cloudflare), donc `checker.php` et le scrape HTML des threads ne passent plus. Ce service fait le relais vers l'API de F95Checker.

Contrairement à la branche `main` (f95list-form-v5), **il n'a pas de base de données et n'écrit rien** : f95-france l'appelle par HTTP et garde toute sa logique métier (bumps de version, notifications Discord, historique, Google Sheets).

## Remerciements

Les données viennent de l'API de cache de **[WillyJL](https://github.com/WillyJL)**, créateur de [F95Checker](https://github.com/WillyJL/F95Checker), qui a autorisé cet usage. Merci à lui : ce service évite de solliciter F95zone directement.

## Fonctionnement

Le flux est celui de F95Checker :

1. `GET /fast?ids=…` par paquets de **10**, **un seul à la fois** dans tout le service, même si plusieurs requêtes arrivent en parallèle. Timeout 120 s. Il renvoie le timestamp du dernier changement de chaque thread.
2. `GET /full/{id}?ts=…` pour les threads dont le timestamp a augmenté, ou dont l'appelant ne connaît pas le timestamp (concurrence limitée par `FULL_CONCURRENCY`).

**C'est à f95-france de stocker le `lastChange`** de chaque jeu et de le renvoyer à l'appel suivant. Sans lui, chaque vérification appelle `/full` pour tous les jeux, ce qui charge inutilement l'API de WillyJL.

Le format réel de l'API est décrit dans [docs/api.md](docs/api.md).

## API HTTP

Toutes les routes, sauf `/health`, demandent `Authorization: Bearer <AUTH_TOKEN>`.

| Route | Rôle | Remplace dans f95-france |
|---|---|---|
| `GET /health` | Healthcheck (Coolify), sans authentification | |
| `POST /threads/check` | Vérifie un lot de threads (**50 au maximum**) | `checker.php` dans l'auto-check |
| `GET /threads/:threadId` | Données fraîches d'un thread | `scrapeF95Thread` (HTML du thread) |

### `POST /threads/check`

```json
{ "threads": [{ "id": 1000, "lastChange": 1782662170 }, { "id": 2000 }] }
```

`lastChange` est facultatif : absent ou `null`, le thread passe par `/full` quoi qu'il arrive. Les doublons sont ignorés. Un corps invalide, vide ou de plus de 50 threads renvoie `400`.

La réponse est toujours un `200`, même si certains threads échouent. Les résultats suivent l'ordre reçu :

```json
{
  "results": [
    { "id": 1000, "result": "unchanged", "lastChange": 1782662170 },
    { "id": 2000, "result": "changed", "lastChange": 1789687254, "status": "completed", "thread": { "name": "…", "version": "…", "…": "…" } },
    { "id": 3000, "result": "not_found" },
    { "id": 4000, "result": "failed", "kind": "network", "message": "…" }
  ]
}
```

- `changed` : à stocker. `lastChange` est le nouveau timestamp, `thread` les données décodées (voir `Thread` dans [src/indexer/schemas.ts](src/indexer/schemas.ts)).
- `unchanged` : rien n'a bougé, `thread` n'est pas renvoyé.
- `not_found` : thread supprimé, privé ou déplacé.
- `failed` : à réessayer au passage suivant, sans toucher au `lastChange` stocké. `kind` vaut `network`, `http`, `index_error`, `invalid_response`, `invalid_timestamp`, `bad_request` ou `aborted`.

Un lot de 50 threads demande 5 appels `/fast` à la suite, d'environ 3 s chacun (davantage si l'API est chargée), plus les `/full`. Côté f95-france, il faut donc un timeout de plusieurs minutes. Si l'appelant coupe la connexion, la vérification s'arrête.

### `GET /threads/:threadId`

Passe par `/fast` puis `/full`, sans rien comparer. Renvoie `{ threadId, lastChange, status, thread }`, `404` si le thread n'existe pas, `502` si l'API de F95Checker est indisponible.

### Conversions

- `status` : `in_progress`, `completed`, `on_hold` ou `abandoned`, d'après [src/mapping.ts](src/mapping.ts). Vaut `null` pour un identifiant inconnu : l'appelant garde alors son statut. L'identifiant brut reste disponible dans `thread.status`.
- `thread.type` (moteur) et `thread.tags` sont des **identifiants numériques non convertis**. Le mapping des tags vient de F95Checker (GPLv3) : reprise à décider.
- `thread.version` vaut `null` si elle est inconnue, `thread.imageUrl` vaut `null` sans image.
- `thread.lastUpdated`, `lastChange` et `thread.cachedAt` sont des timestamps unix en secondes.

## Configuration

Voir [.env.example](.env.example). Seul `AUTH_TOKEN` (16 caractères minimum) est obligatoire.

Le User-Agent envoyé à l'API, `f95list-scraper/<version> (+<USER_AGENT_CONTACT>)`, permet à WillyJL d'identifier le projet en cas de congestion.

## Logs

Une ligne JSON par log sur la sortie standard, au format [ECS](https://www.elastic.co/docs/reference/ecs) : c'est au collecteur (Filebeat, Elastic Agent…) de les expédier vers Elasticsearch.

`event.action` nomme l'événement, tout le reste des données est sous `scraper.*`, une erreur sous `error.*`.

| `event.action` | Niveau | Contenu (`scraper.*`) |
|---|---|---|
| `threads.checked` | info | `total`, `changed`, `unchanged`, `notFound`, `failed` |
| `indexer.request` | info pour `/fast`, debug pour le reste, warn si échec ou plus de 30 s | `path`, `status`, `durationMs`, `cache` (`cf-cache-status`) |
| `indexer.error` | warn | `kind`, `reason` (API de F95Checker en panne) |
| `http.request` | info, warn si 4xx, error si 5xx | `method`, `path`, `route`, `status`, `durationMs` (le healthcheck est exclu) |

## Développement

```sh
bun install
cp .env.example .env     # renseigner AUTH_TOKEN
bun run dev              # serveur avec rechargement
bun test                 # tests
bun run check            # typecheck
bun run lint             # Biome
```

Pour voir ce que renvoie la vraie API :

```sh
bun run explore 1000 2000          # /fast puis /full (10 ids maximum, séquentiel)
bun run explore --raw 1000         # /raw seulement
bun run explore --json 1000        # réponse complète décodée
```

## Déploiement (Coolify)

- Application construite depuis le `Dockerfile`, port `3000`, healthcheck `/health` (déjà défini dans l'image).
- Variables d'environnement : `AUTH_TOKEN`, et `USER_AGENT_CONTACT` si besoin.
- Pas de Scheduled Task : c'est le cron de f95-france (`/api/cron/check-version`) qui appelle ce service.
- **Une seule instance** : la garantie « un seul `/fast` à la fois » est en mémoire.

> **Avant la première vérification** : tous les `lastChange` sont inconnus, donc chaque jeu passe par `/full`, et les threads absents du cache de WillyJL sont réindexés chez lui. Le prévenir avant, et lui confirmer que f95-france utilise aussi son API.
