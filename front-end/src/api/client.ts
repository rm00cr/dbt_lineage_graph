/**
 * Thin REST client for contract v0.
 *
 * Base URL resolution:
 *   VITE_API_BASE_URL set  -> talk to that origin directly
 *   empty (default)        -> relative '/api', served by the Vite dev proxy
 */

import type {
  ColumnLineageResponse,
  DiffResponse,
  GraphResponse,
  LineageStatusResponse,
  MetaResponse,
  ModelDetail,
  SearchResponse,
  TraceDirection,
} from './types'

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Params = Record<string, string | string[] | boolean | number | undefined>

async function get<T>(path: string, params?: Params): Promise<T> {
  return request<T>(path, params)
}

async function request<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)))
    else url.searchParams.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
  } catch (cause) {
    throw new ApiError(`API not reachable at ${url.pathname} (${(cause as Error).message})`)
  }

  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = (await response.json()) as { detail?: string | { msg: string }[] }
      if (typeof body.detail === 'string') detail = body.detail
      else if (Array.isArray(body.detail)) detail = body.detail.map((d) => d.msg).join('; ')
    } catch {
      /* body was not JSON — keep statusText */
    }
    throw new ApiError(detail, response.status)
  }

  return (await response.json()) as T
}

export const api = {
  meta: () => get<MetaResponse>('/api/meta'),

  graph: (options: { pipeline?: string[]; stage?: string[]; includeSources?: boolean } = {}) =>
    get<GraphResponse>('/api/graph', {
      ...(options.pipeline?.length ? { pipeline: options.pipeline } : {}),
      ...(options.stage?.length ? { stage: options.stage } : {}),
      ...(options.includeSources === false ? { include_sources: false } : {}),
    }),

  /** `state`: the state_id of a comparison, to read the uploaded version of the node */
  model: (id: string, state?: string) => get<ModelDetail>(`/api/model/${encodeURIComponent(id)}`, { state }),

  /** compare the running state with an uploaded manifest (+ catalog) */
  /** `pipeline`: the pipelines.yaml name of the pipeline the upload replaces */
  diff: (manifest: File, catalog?: File | null, label?: string, pipeline?: string) => {
    const form = new FormData()
    form.append('manifest', manifest)
    if (catalog) form.append('catalog', catalog)
    if (label) form.append('label', label)
    if (pipeline) form.append('pipeline', pipeline)
    return request<DiffResponse>('/api/diff', undefined, { method: 'POST', body: form })
  },

  searchModels: (q: string, limit = 20) => get<SearchResponse>('/api/search', { q, limit }),

  searchColumns: (q: string, limit = 50) => get<SearchResponse>('/api/search/columns', { q, limit }),

  columnLineage: (model: string, column: string, direction: TraceDirection = 'both', depth?: number) =>
    get<ColumnLineageResponse>('/api/lineage/column', {
      model,
      column,
      direction,
      ...(depth ? { depth } : {}),
    }),

  lineageStatus: () => get<LineageStatusResponse>('/api/lineage/status'),
}
