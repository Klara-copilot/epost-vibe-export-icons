import type { Pipeline, Settings } from '../state/settings';
import type {
  BrowseResponse,
  ConfigResponse,
  DeployResponse,
  PickFolderResponse,
  RegisterResponse,
  SearchResponse,
  WorkflowEvent,
  WorkflowSelection,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${settings.serverUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${settings.token}`,
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function getStatus(settings: Pick<Settings, 'serverUrl' | 'token'>) {
  return request<{ ok: true }>(settings, '/api/status');
}

export function getConfig(settings: Pick<Settings, 'serverUrl' | 'token'>) {
  return request<ConfigResponse>(settings, '/api/config');
}

export function updateConfig(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  config: Partial<ConfigResponse>,
) {
  return request<ConfigResponse>(settings, '/api/config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export function browse(settings: Pick<Settings, 'serverUrl' | 'token'>, path: string) {
  const qs = new URLSearchParams({ path });
  return request<BrowseResponse>(settings, `/api/browse?${qs}`);
}

export function pickFolder(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  defaultPath: string,
) {
  return request<PickFolderResponse>(settings, '/api/pick-folder', {
    method: 'POST',
    body: JSON.stringify({ defaultPath }),
  });
}

export function search(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  pipeline: Pipeline,
  term: string,
) {
  const qs = new URLSearchParams({ pipeline, term });
  return request<SearchResponse>(settings, `/api/search?${qs}`);
}

/** Fetches the raw SVG markup for a search result, for thumbnail previews. */
export async function getSvgPreview(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  pipeline: Pipeline,
  name: string,
  sourceLabel?: string,
): Promise<string> {
  const qs = new URLSearchParams({ pipeline, name, ...(sourceLabel ? { sourceLabel } : {}) });
  const res = await fetch(`${settings.serverUrl}/api/svg-preview?${qs}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.text();
}

export function register(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  pipeline: Pipeline,
  name: string,
) {
  return request<RegisterResponse>(settings, '/api/register', {
    method: 'POST',
    body: JSON.stringify({ pipeline, name }),
  });
}

export function deploy(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  pipeline: Pipeline,
  names: string[],
) {
  return request<DeployResponse>(settings, '/api/deploy', {
    method: 'POST',
    body: JSON.stringify({ pipeline, names }),
  });
}

/**
 * Export streams newline-delimited log text over a chunked HTTP response.
 * EventSource can't send an Authorization header, so we read the fetch
 * response body directly instead of using the EventSource API.
 */
export async function streamExport(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  pipeline: Pipeline,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${settings.serverUrl}/api/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify({ pipeline }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  if (buffer) onLine(buffer);
}

/**
 * Shared NDJSON stream reader: fetches, checks for errors, and calls onEvent
 * for each newline-delimited JSON object in the response body.
 */
async function streamNdjson(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  path: string,
  init: RequestInit,
  onEvent: (event: WorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${settings.serverUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${settings.token}`,
      ...init.headers,
    },
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onEvent(JSON.parse(trimmed) as WorkflowEvent);
      } catch {
        // Skip unparseable lines (shouldn't happen but be defensive)
      }
    }
  }
  if (buffer.trim()) {
    try { onEvent(JSON.parse(buffer) as WorkflowEvent); } catch { /* ignore */ }
  }
}

/**
 * Step 1 of the automated workflow: clone both repos (theme_icons + luz_next)
 * into a fresh session workspace on the bridge server, streaming clone
 * progress. Emits a `{ type: 'session', id }` event once ready — search and
 * run calls must pass that session id.
 */
export function prepareWorkflow(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  onEvent: (event: WorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson(settings, '/api/workflow/prepare', { method: 'POST' }, onEvent, signal);
}

/** Search for icons within an already-prepared session's cloned theme_icons. */
export function searchWorkflowSession(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  sessionId: string,
  pipeline: Pipeline,
  term: string,
) {
  const qs = new URLSearchParams({ session: sessionId, pipeline, term });
  return request<SearchResponse>(settings, `/api/workflow/search?${qs}`);
}

/** Fetch raw SVG markup for a preview within an already-prepared session. */
export async function getWorkflowSvgPreview(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  sessionId: string,
  pipeline: Pipeline,
  name: string,
  sourceLabel?: string,
): Promise<string> {
  const qs = new URLSearchParams({
    session: sessionId, pipeline, name, ...(sourceLabel ? { sourceLabel } : {}),
  });
  const res = await fetch(`${settings.serverUrl}/api/workflow/svg-preview?${qs}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.text();
}

/**
 * Step 2 of the automated workflow: audit -> export -> commit -> push against
 * an already-prepared session's cloned repos, streaming NDJSON WorkflowEvents.
 *
 * The `signal` here only aborts the client's HTTP read — it deliberately does
 * NOT stop the underlying process on the server (this endpoint performs real
 * git commits/pushes, so a dropped browser connection must never interrupt
 * it). To actually stop a run, call `cancelWorkflow`.
 */
export function runWorkflow(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  body: { session: string; selections: WorkflowSelection[]; branchId?: string; skipGit?: boolean },
  onEvent: (event: WorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson(
    settings,
    '/api/workflow/run',
    { method: 'POST', body: JSON.stringify(body) },
    onEvent,
    signal,
  );
}

/** Explicitly stop an in-flight /run process for a session (real cancel, server-side). */
export function cancelWorkflow(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  sessionId: string,
) {
  return request<{ ok: true }>(settings, '/api/workflow/cancel', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId }),
  });
}

/**
 * Re-attempt a failed push for a session (e.g. after a network error). Streams
 * NDJSON WorkflowEvents just like /run. Can be called repeatedly until every
 * repo's push succeeds (server emits `push-complete` when fully done, or another
 * `push-retry` if some repos still failed).
 */
export function retryPushWorkflow(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  sessionId: string,
  onEvent: (event: WorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson(
    settings,
    '/api/workflow/retry-push',
    { method: 'POST', body: JSON.stringify({ session: sessionId }) },
    onEvent,
    signal,
  );
}

/** Discard a prepared session's cloned workspace (e.g. on reset/cancel). */
export function cleanupWorkflowSession(
  settings: Pick<Settings, 'serverUrl' | 'token'>,
  sessionId: string,
) {
  return request<{ ok: true }>(settings, '/api/workflow/cleanup', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId }),
  });
}

