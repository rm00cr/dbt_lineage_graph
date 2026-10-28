/**
 * Thin REST client for contract v0.
 *
 * Base URL resolution:
 *   VITE_API_BASE_URL set  -> talk to that origin directly
 *   empty (default)        -> relative '/api', served by the Vite dev proxy
 */

import type { GraphResponse, MetaResponse, ModelDetail, SearchResponse } from './types'

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

async function get<T>(path: string, params?: Record<string, string | string[] | boolean | number>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)))
    else url.searchParams.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (cause) {
    throw new ApiError(`API not reachable at ${url.pathname} (${(cause as Error).message})`)
  }

  if (!response.ok) {
    let detail = response.statusText
    try {
      detail = ((await response.json()) as { detail?: string }).detail ?? detail
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

  model: (id: string) => get<ModelDetail>(`/api/model/${encodeURIComponent(id)}`),

  searchModels: (q: string, limit = 20) => get<SearchResponse>('/api/search', { q, limit }),

  searchColumns: (q: string, limit = 50) => get<SearchResponse>('/api/search/columns', { q, limit }),
}
