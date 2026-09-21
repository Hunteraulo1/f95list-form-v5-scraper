//? Interroge la vraie API pour voir ce qu'elle renvoie, sans rien écrire.
//?   bun run explore 1000 2000          → /fast puis /full de ces ids (10 maximum, séquentiel)
//?   bun run explore --raw 1000         → /raw seulement (pas de réindexage)
//?   bun run explore --json 1000        → sortie complète décodée

import { loadConfig } from '../src/config.ts';
import { createIndexerClient, IndexerError } from '../src/indexer/client.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const ids = args.filter((arg) => !arg.startsWith('--')).map(Number);

if (ids.length === 0) {
  console.error('Usage : bun run explore [--raw] [--json] <id> [<id>…]');
  process.exit(1);
}

const { indexerUrl, userAgent } = loadConfig({
  ...process.env,
  AUTH_TOKEN: process.env.AUTH_TOKEN ?? 'explore-script-no-server',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'mysql://unused:unused@localhost/unused',
});
const client = createIndexerClient({ baseUrl: indexerUrl, userAgent });
console.error(`→ ${indexerUrl}  (${userAgent})\n`);

const show = (id: number, thread: Awaited<ReturnType<typeof client.raw>>) => {
  if (flags.has('--json')) {
    console.log(JSON.stringify({ id, ...thread }, null, 2));
    return;
  }
  console.log(
    `#${id} ${JSON.stringify(thread.name)}`,
    `v=${JSON.stringify(thread.version)}`,
    `type=${thread.type} status=${thread.status}`,
    `tags=${thread.tags.length} downloads=${thread.downloads.length}`,
    `reviews=${thread.reviews.length}/${thread.reviewsTotal}`,
    `image=${thread.imageUrl ?? '—'}`,
  );
};

const report = (id: number, error: unknown) =>
  console.log(
    `#${id} ✗`,
    error instanceof IndexerError ? `${error.kind} — ${error.message}` : error,
  );

if (flags.has('--raw')) {
  for (const id of ids) {
    try {
      show(id, await client.raw(id));
    } catch (error) {
      report(id, error);
    }
  }
} else {
  const timestamps = await client.fast(ids);
  console.log('/fast', Object.fromEntries(timestamps), '\n');
  for (const id of ids) {
    const ts = timestamps.get(id);
    if (!ts) {
      console.log(`#${id} ✗ pas de timestamp`);
      continue;
    }
    try {
      show(id, await client.full(id, ts));
    } catch (error) {
      report(id, error);
    }
  }
}
