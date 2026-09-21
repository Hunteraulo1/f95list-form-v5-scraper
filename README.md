# f95list-form-v5-scraper

Service de synchronisation des jeux pour [f95list-form-v5](https://github.com/Hunteraulo1/f95list-form-v5). Il n'a pas d'interface : le projet principal le pilote par HTTP, et Coolify déclenche les mises à jour automatiques.

## Remerciements

Les données viennent de l'API de cache de **[WillyJL](https://github.com/WillyJL)**, créateur de [F95Checker](https://github.com/WillyJL/F95Checker), qui a autorisé cet usage. Merci à lui : ce service évite de solliciter F95zone directement.

## Fonctionnement

Le flux est celui de F95Checker :

1. `GET /fast?ids=…` par paquets de **10**, **un seul à la fois** dans tout le service (cycle, actualisation manuelle et aperçu compris), timeout 120 s. Il renvoie le timestamp du dernier changement de chaque jeu.
2. `GET /full/{id}?ts=…` pour les jeux dont le timestamp a augmenté (concurrence limitée par `FULL_CONCURRENCY`).
3. Les données sont décodées puis écrites dans la base du projet principal.

Seuls les jeux dont l'origine est **F95zone** passent par cette API. Le format réel de l'API est décrit dans [docs/api.md](docs/api.md).

### Ce qui est écrit en base

| Table | Colonnes | Conditions |
|---|---|---|
| `game` | `description`, `image_external`, `developer`, `last_updated`, `downloads`, `reviews`, `score`, `votes`, `last_change` | tous les jeux F95zone concernés |
| `game` | `name` | **uniquement** avec `updateName` (nouveau jeu), jamais par le cron |
| `game_edition` | `version`, `status`, `last_auto_check` | éditions avec `auto_check = 1` et `active = 1` |

Détails de conversion (voir [src/db/columns.ts](src/db/columns.ts)) :
- `last_updated` est écrit **en UTC**, quel que soit le fuseau de la session MariaDB : ton projet doit le lire comme de l'UTC. C'est la date de mise à jour du thread, que l'API remplace par la date du jour à chaque changement de version.
- `downloads` est un JSON `[{platform, links: [{host, url}]}]`. Les « liens » XPath hérités de l'API (`//a[starts-with(@href,…)]`) sont **écartés**, car inutilisables ; les plateformes qui n'ont plus aucun lien disparaissent aussi.
- `reviews` est un JSON `[{user, score, message, likes, timestamp}]`.
- `score` et `votes` sont écrits tels quels, sauf qu'**un jeu sans vote a un `score` nul** (le `0.0` de l'API signifie « pas noté »).

Une valeur vide ou inconnue côté API (description vide, pas d'image, pas de développeur, pas de lien, statut « unchecked ») **n'efface jamais** la valeur en base. `description_fr` n'est jamais touché. Les tags ne sont pas encore synchronisés.

Le schéma appartient au projet principal (MikroORM) : le scraper ne migre rien. Il a besoin des colonnes de `game` ajoutées par les migrations `Migration20260921120000_add_game_last_change` et `Migration20260921130000_add_game_f95checker_data` de f95list-form-v5.

## API HTTP

Toutes les routes, sauf `/health`, demandent `Authorization: Bearer <AUTH_TOKEN>`.

| Route | Rôle |
|---|---|
| `GET /health` | Healthcheck (Coolify), sans authentification |
| `POST /sync` | Lance un cycle sur les jeux lus en base. Corps optionnel : `{ "scope": "active" \| "inactive" \| "all" }` (`all` par défaut). Répond `202`, ou `409` si un cycle est déjà en cours |
| `GET /status` | État du cycle en cours et rapport du dernier cycle |
| `POST /games/:gameId/refresh` | Actualise un jeu existant, sans comparer au `last_change`. Corps optionnel : `{ "updateName": true }` (`false` par défaut) |
| `GET /threads/:threadId` | Aperçu d'un jeu pas encore en base : renvoie les données décodées et le statut converti, **sans rien écrire** |

`gameId` est l'id du jeu en base, `threadId` l'id du thread F95zone. `POST /games/:gameId/refresh` renvoie `404` (jeu inconnu, ou thread supprimé côté F95), `422` (origine autre que F95zone, ou pas de `thread_id`) ou `502` (API de F95Checker indisponible).

Le verrou de cycle est en mémoire : **une seule instance** du service (pas de réplicas dans Coolify).

### Portée du cron

- `active` : jeux **actifs** avec au moins une traduction active (édition active et traduction active). À lancer **toutes les 6 h**.
- `inactive` : tous les autres jeux F95zone en `auto_check` : jeu inactif, ou sans traduction active. **Une fois par jour** suffit.

## Configuration

Voir [.env.example](.env.example). `DATABASE_URL` et `AUTH_TOKEN` (16 caractères minimum) sont obligatoires. En production, préférer un utilisateur MariaDB limité aux droits `SELECT` et `UPDATE` sur les tables `game`, `game_edition`, `game_translation` et `origin-website`.

Le User-Agent envoyé à l'API, `f95list-scraper/<version> (+<USER_AGENT_CONTACT>)`, permet à WillyJL d'identifier ce projet en cas de congestion.

## Logs

Une ligne JSON par log sur la sortie standard, au format [ECS](https://www.elastic.co/docs/reference/ecs) : c'est au collecteur de la nouvelle stack (Filebeat, Elastic Agent…) de les expédier vers Elasticsearch. Rien n'est écrit en base pour ça.

```json
{"log":{"level":"warn"},"@timestamp":"…","service":{"name":"f95list-scraper","type":"bun","environment":"prod"},
 "event":{"dataset":"f95list-scraper","action":"sync.game.failed"},
 "scraper":{"runId":"…","threadId":42,"kind":"network","reason":"…"},"message":"échec de synchro du thread 42 (network)"}
```

`event.action` nomme l'événement, tout le reste des données est sous `scraper.*`, une erreur sous `error.*`. `scraper.runId` relie tous les logs d'un même cycle.

| `event.action` | Niveau | Contenu (`scraper.*`) |
|---|---|---|
| `sync.started` | info | `runId`, `scope`, `total` |
| `sync.finished` | info, warn si `partial`/`aborted`, error si `failed` | `runId`, `scope`, `outcome` (`success`, `partial`, `aborted`, `failed`), `total`, `checked`, `changed`, `updated`, `unchanged`, `notFound`, `failed`, `durationMs` |
| `sync.game.updated` | info | `runId`, `threadId`, `lastChange`, `version`, `apiStatus`, `games`, `editions` |
| `sync.game.not_found` | warn | `runId`, `threadId` (thread supprimé, privé ou déplacé) |
| `sync.game.failed` | warn, error si `bad_request`/`invalid_response` | `runId`, `threadId`, `kind`, `reason` |
| `game.refreshed` | info | `gameId`, `threadId`, `updateName`, `lastChange`, `games`, `editions` |
| `indexer.request` | info pour `/fast`, debug pour le reste, warn si échec ou plus de 30 s | `path`, `status`, `durationMs`, `cache` (`cf-cache-status`) |
| `indexer.error` | warn | `kind`, `reason` (API de F95Checker en panne) |
| `http.request` | info, warn si 4xx, error si 5xx | `method`, `path`, `route`, `status`, `durationMs` (le healthcheck est exclu) |

Pistes de requêtes Kibana : `event.action: "sync.finished" and scraper.outcome: "partial"` (cycles à problème), `event.action: "sync.game.failed"` (jeux en erreur), `event.action: "indexer.request" and scraper.path: /fast*` (latence de `/fast`, à regarder avant d'incriminer le scraper si WillyJL est lent). Un `sync.started` sans `sync.finished` correspondant (même `runId`) signale un cycle interrompu brutalement.

## Développement

```sh
bun install
cp .env.example .env     # renseigner DATABASE_URL et AUTH_TOKEN
bun run dev              # serveur avec rechargement
bun test                 # tests (les tests SQL sont ignorés sans TEST_DATABASE_URL)
bun run check            # typecheck
bun run lint             # Biome
```

Tests d'intégration SQL, contre une vraie MariaDB. Ils **détruisent** les tables `game*` et `origin-website` de la base visée : n'utiliser qu'une base dédiée.

```sh
docker exec f95list-form-v5-mariadb mariadb -uroot -proot -e "create database if not exists f95scraper_test"
TEST_DATABASE_URL=mysql://root:root@localhost:3306/f95scraper_test bun test
```

Pour voir ce que renvoie la vraie API, sans rien écrire :

```sh
bun run explore 1000 2000          # /fast puis /full (10 ids maximum, séquentiel)
bun run explore --raw 1000         # /raw seulement
bun run explore --json 1000        # réponse complète décodée
```

## Déploiement (Coolify)

- Application construite depuis le `Dockerfile`, port `3000`, healthcheck `/health` (déjà défini dans l'image).
- Variables d'environnement : `DATABASE_URL`, `AUTH_TOKEN`, et `USER_AGENT_CONTACT` si besoin.
- Deux Scheduled Tasks, chacune un `curl -X POST` vers `/sync` avec le token :
  - `0 */6 * * *` avec `{"scope":"active"}`
  - `30 3 * * *` avec `{"scope":"inactive"}`

> **Avant la toute première synchro** : la première passe est « à froid » (`last_change` nul partout). Chaque thread absent du cache de WillyJL est alors réindexé un par un chez lui. Le prévenir avant de lancer le premier cycle sur ~2 700 jeux, comme le demande le passation (section 8.1).
