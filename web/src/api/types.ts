import type { Pipeline } from '../state/settings';

export interface ConfigResponse {
  projectRoot: string;
  themePath: string;
  pipelineUuids: Record<string, string>;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface BrowseResponse {
  path: string;
  entries: BrowseEntry[];
}

export interface SearchResult {
  name: string;
  sourceLabel?: string;
  matchedStyles?: string[];
}

export interface SearchResponse {
  pipeline: Pipeline;
  term: string;
  results: SearchResult[];
}

export interface RegisterRequest {
  pipeline: Pipeline;
  name: string;
}

export interface RegisterResponse {
  registered: boolean;
  uuid?: string;
  reason?: string;
}

export interface DeployResponse {
  branch: string;
  commit: string;
  prUrl?: string;
}

export type PickFolderResponse =
  | { status: 'ok'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason?: string };

// ─── Automated workflow types ─────────────────────────────────────────────────

export interface WorkflowSelection {
  pipeline: Pipeline;
  name: string;
}

export type WorkflowStageId =
  | 'clone-theme-icons'
  | 'clone-luz-next'
  | 'clone-klara-theme'
  | `audit-${'icon' | 'duotone' | 'illustration'}`
  | `export-${'icon' | 'duotone' | 'illustration'}`
  | 'commit-theme-icons'
  | 'commit-luz-next'
  | 'commit-klara-theme'
  | 'cleanup'
  | 'system';

export type WorkflowStageStatus = 'start' | 'ok' | 'warn' | 'error';

export interface WorkflowStageEvent {
  type: 'stage';
  id: WorkflowStageId;
  status: WorkflowStageStatus;
  label: string;
  detail?: string;
}

export interface WorkflowLogEvent {
  type: 'log';
  stage: string;
  line: string;
}

export interface WorkflowPipelineResult {
  exported: string[];
  alreadyDone: string[];
  failed: string[];
}

export interface WorkflowResult {
  status: 'success' | 'partial' | 'failed';
  prUrl: string | null;
  branchName: string | null;
  luzNextPrUrl: string | null;
  luzNextBranchName: string | null;
  klaraThemePrUrl: string | null;
  klaraThemeBranchName: string | null;
  pipelines: {
    icon: WorkflowPipelineResult;
    duotone: WorkflowPipelineResult;
    illustration: WorkflowPipelineResult;
  };
  diff: string | null;
  error: string | null;
}

export interface WorkflowResultEvent {
  type: 'result';
  result: WorkflowResult;
}

/** Emitted once by POST /api/workflow/prepare after both repos are cloned. */
export interface WorkflowSessionEvent {
  type: 'session';
  id: string;
}

/**
 * Emitted by /run or /retry-push when a commit landed locally but the push to
 * origin failed (e.g. a network error). The listed repos can be retried via
 * POST /api/workflow/retry-push without re-cloning or re-exporting.
 */
export interface WorkflowPushRetryEvent {
  type: 'push-retry';
  branchName: string;
  repos: string[];
}

/** Emitted by /retry-push once every pending repo has been pushed. */
export interface WorkflowPushCompleteEvent {
  type: 'push-complete';
  prUrls: Record<string, string | null>;
}

export type WorkflowEvent =
  | WorkflowStageEvent
  | WorkflowLogEvent
  | WorkflowResultEvent
  | WorkflowSessionEvent
  | WorkflowPushRetryEvent
  | WorkflowPushCompleteEvent;
