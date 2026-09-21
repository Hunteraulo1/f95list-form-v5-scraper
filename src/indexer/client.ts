import * as v from 'valibot';
import {
  fastResponseSchema,
  indexEnvelopeSchema,
  type Thread,
  threadSchema,
} from './schemas.ts';

export const FAST_MAX_IDS = 10;
const THREAD_ID_MAX = 999_999;

export type IndexerErrorKind =
  //? Thread supprimé, privé ou déplacé (`404 THREAD_MISSING`).
  | 'not_found'
  //? L'indexeur n'a pas pu lire le thread (`INDEX_ERROR` non vide, autre que THREAD_MISSING).
  | 'index_error'
  //? `400` (id invalide) ou `406` (`ts` dans le futur) : c'est un bug de notre côté.
  | 'bad_request'
  | 'http'
  | 'network'
  | 'invalid_response';

export class IndexerError extends Error {
  constructor(
    readonly kind: IndexerErrorKind,
    message: string,
    readonly options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'IndexerError';
  }
}

export interface IndexerClient {
  /** Timestamp du dernier changement de chaque id. Déclenche le réindexage côté API. */
  fast(ids: number[], signal?: AbortSignal): Promise<Map<number, number>>;
  /** Données complètes. `ts` doit être celui renvoyé par `fast` (clé de cache Cloudflare). */
  full(id: number, ts: number, signal?: AbortSignal): Promise<Thread>;
  /** Dernière donnée en cache, sans réindexage, possiblement périmée (1 jour maximum). */
  raw(id: number, signal?: AbortSignal): Promise<Thread>;
}

export interface RequestInfo {
  path: string;
  /** Nul quand la requête n'a pas abouti (timeout, réseau coupé). */
  status: number | null;
  durationMs: number;
  /** En-tête `cf-cache-status` de Cloudflare (HIT, MISS, DYNAMIC…), utile pour juger la charge. */
  cache: string | null;
  error?: string;
}

export interface IndexerClientOptions {
  /** Appelé après chaque requête, réussie ou non : sert à journaliser latences et échecs. */
  onRequest?: (info: RequestInfo) => void;
  baseUrl: string;
  userAgent: string;
  /** 120 s conseillés par WillyJL : `/fast` peut être long si d'autres réindexages sont en cours. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const assertThreadId = (id: number) => {
  if (!Number.isInteger(id) || id < 1 || id > THREAD_ID_MAX) {
    throw new IndexerError('bad_request', `Id de thread invalide : ${id}`);
  }
};

export const createIndexerClient = ({
  baseUrl,
  userAgent,
  timeoutMs = 120_000,
  fetch = globalThis.fetch,
  onRequest,
}: IndexerClientOptions): IndexerClient => {
  const base = baseUrl.replace(/\/+$/, '');

  const get = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { 'user-agent': userAgent, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      onRequest?.({
        path,
        status: null,
        durationMs: elapsed(),
        cache: null,
        error: String(cause),
      });
      throw new IndexerError('network', `GET ${path} : ${String(cause)}`, {
        cause,
      });
    }
    onRequest?.({
      path,
      status: response.status,
      durationMs: elapsed(),
      cache: response.headers.get('cf-cache-status'),
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new IndexerError(
        response.ok ? 'invalid_response' : 'http',
        `GET ${path} : corps non JSON (HTTP ${response.status})`,
        { status: response.status, cause },
      );
    }
    return { status: response.status, body };
  };

  const parse = <TSchema extends v.GenericSchema>(
    schema: TSchema,
    input: unknown,
    path: string,
  ): v.InferOutput<TSchema> => {
    const result = v.safeParse(schema, input);
    if (!result.success) {
      throw new IndexerError(
        'invalid_response',
        `GET ${path} : ${v.summarize(result.issues)}`,
      );
    }
    return result.output;
  };

  //? `/full` et `/raw` partagent le même contrat.
  const getThread = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<Thread> => {
    const { status, body } = await get(path, signal);

    if (status === 400 || status === 406) {
      throw new IndexerError('bad_request', `GET ${path} : HTTP ${status}`, {
        status,
      });
    }

    //? Le corps d'erreur contient `INDEX_ERROR`, y compris sur un `404` (`THREAD_MISSING`).
    const envelope = v.safeParse(indexEnvelopeSchema, body);
    if (envelope.success && envelope.output.INDEX_ERROR !== '') {
      const code = envelope.output.INDEX_ERROR;
      throw new IndexerError(
        status === 404 || code === 'THREAD_MISSING'
          ? 'not_found'
          : 'index_error',
        `GET ${path} : ${code}`,
        { status, code },
      );
    }

    if (status !== 200) {
      throw new IndexerError('http', `GET ${path} : HTTP ${status}`, {
        status,
      });
    }
    return parse(threadSchema, body, path);
  };

  return {
    async fast(ids, signal) {
      if (ids.length === 0 || ids.length > FAST_MAX_IDS) {
        throw new IndexerError(
          'bad_request',
          `/fast accepte de 1 à ${FAST_MAX_IDS} ids (reçu : ${ids.length})`,
        );
      }
      for (const id of ids) assertThreadId(id);

      const path = `/fast?ids=${ids.join(',')}`;
      const { status, body } = await get(path, signal);
      if (status !== 200) {
        throw new IndexerError(
          status === 400 ? 'bad_request' : 'http',
          `GET ${path} : HTTP ${status}`,
          { status },
        );
      }
      const record = parse(fastResponseSchema, body, path);
      return new Map(
        Object.entries(record).map(([id, ts]) => [Number(id), ts]),
      );
    },

    full(id, ts, signal) {
      assertThreadId(id);
      return getThread(`/full/${id}?ts=${ts}`, signal);
    },

    raw(id, signal) {
      assertThreadId(id);
      return getThread(`/raw/${id}`, signal);
    },
  };
};
