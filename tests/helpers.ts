import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.ts';

export const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  );

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// biome-ignore lint/suspicious/noExplicitAny: lignes JSON lues nettement plus simplement en test
type LogLine = Record<string, any>;

//? Logger branché sur un tampon : chaque ligne JSON écrite est relue et décodée.
export const captureLogger = (level = 'debug') => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level, stream });
  return {
    logger,
    lines: (): LogLine[] =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    /** Lignes dont `event.action` vaut `action`. */
    events: (action: string): LogLine[] =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((line) => line.event?.action === action),
  };
};
