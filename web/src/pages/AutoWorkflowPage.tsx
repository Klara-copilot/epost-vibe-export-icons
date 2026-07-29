import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Settings } from '../state/settings';
import type {
  WorkflowSelection,
  WorkflowEvent,
  WorkflowStageEvent,
  WorkflowResult,
} from '../api/types';
import { prepareWorkflow, runWorkflow, cancelWorkflow, cleanupWorkflowSession, retryPushWorkflow } from '../api/client';
import { SelectionSearch } from '../components/auto/SelectionSearch';
import { SelectionTray } from '../components/auto/SelectionTray';
import { LaunchBar } from '../components/auto/LaunchBar';
import { PipelineTimeline, type StageState } from '../components/auto/PipelineTimeline';
import { WorkflowResultCard } from '../components/auto/WorkflowResultCard';
import { LiveConsole, type ConsoleLine } from '../components/auto/LiveConsole';

interface Props {
  settings: Settings;
}

// The automated flow always clones both repositories FIRST — the icon source
// assets live inside theme_icons, so search cannot work until the clone
// completes. Only after `session` is set can the user search/select icons.
type Phase = 'ready' | 'preparing' | 'selecting' | 'running' | 'done' | 'error';

// Canonical stage ordering for display — earlier stages appear first.
const STAGE_ORDER = [
  'clone-theme-icons',
  'clone-luz-next',
  'audit-icon',
  'audit-duotone',
  'audit-illustration',
  'export-icon',
  'export-duotone',
  'export-illustration',
  'commit-theme-icons',
  'commit-luz-next',
  'cleanup',
  'system',
];

function stageIndex(id: string) {
  const idx = STAGE_ORDER.indexOf(id);
  return idx === -1 ? STAGE_ORDER.length : idx;
}

/** Mutable helper bound to a stage map + setter, shared by prepare and run. */
function makeStageTracker(setStages: (updater: (prev: StageState[]) => StageState[]) => void) {
  const stageMap = new Map<string, StageState>();

  function flush() {
    const sorted = Array.from(stageMap.values()).sort(
      (a, b) => stageIndex(a.event.id) - stageIndex(b.event.id),
    );
    setStages(() => [...sorted]);
  }

  function upsertStage(event: WorkflowStageEvent) {
    const existing = stageMap.get(event.id);
    if (existing) {
      existing.event = event;
    } else {
      stageMap.set(event.id, { event, logs: [] });
    }
    flush();
  }

  function appendLog(stageId: string, line: string) {
    let entry = stageMap.get(stageId);
    if (!entry) {
      const syntheticEvent: WorkflowStageEvent = {
        type: 'stage',
        id: stageId as WorkflowStageEvent['id'],
        status: 'start',
        label: stageId,
      };
      entry = { event: syntheticEvent, logs: [] };
      stageMap.set(stageId, entry);
    }
    entry.logs.push(line);
    flush();
  }

  return { upsertStage, appendLog };
}

export function AutoWorkflowPage({ settings }: Props) {
  const [phase, setPhase] = useState<Phase>('ready');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prepareStages, setPrepareStages] = useState<StageState[]>([]);
  const [selections, setSelections] = useState<WorkflowSelection[]>([]);
  const [branchId, setBranchId] = useState(() => String(Date.now()));
  const [skipGit, setSkipGit] = useState(false);
  const [runStages, setRunStages] = useState<StageState[]>([]);
  const [workflowResult, setWorkflowResult] = useState<WorkflowResult | null>(null);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Flat, unfiltered stream of everything the server/CLI emit — this is what
  // lets us trace failures that happen before any stage card even exists
  // (e.g. argument validation errors, an immediate crash on launch).
  const [prepareConsole, setPrepareConsole] = useState<ConsoleLine[]>([]);
  const [runConsole, setRunConsole] = useState<ConsoleLine[]>([]);
  // Set when a commit landed but the push to origin failed — enables the
  // manual "Retry push" button so the user can re-push until it succeeds.
  const [pushRetry, setPushRetry] = useState<{ branchName: string; repos: string[] } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Best-effort cleanup of any still-open session when the page unmounts
  // (e.g. user switches back to Wizard mode mid-flow).
  useEffect(() => {
    return () => {
      const id = sessionIdRef.current;
      if (id) cleanupWorkflowSession(settings, id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdd = useCallback((sel: WorkflowSelection) => {
    setSelections(prev => {
      if (prev.some(s => s.pipeline === sel.pipeline && s.name === sel.name)) return prev;
      return [...prev, sel];
    });
  }, []);

  const handleRemove = useCallback((idx: number) => {
    setSelections(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleClearAll = useCallback(() => setSelections([]), []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedStage(prev => (prev === id ? null : id));
  }, []);

  // ── Step 1: clone both repos, then unlock search ──────────────────────────
  const handlePrepare = useCallback(async () => {
    setPhase('preparing');
    setPrepareStages([]);
    setPrepareConsole([]);
    setFatalError(null);

    const abort = new AbortController();
    abortRef.current = abort;
    const tracker = makeStageTracker(setPrepareStages);

    try {
      let newSessionId: string | null = null;
      await prepareWorkflow(
        settings,
        (event: WorkflowEvent) => {
          if (event.type === 'stage') {
            tracker.upsertStage(event);
            setPrepareConsole(prev => [...prev, {
              stage: event.id,
              line: `${event.status.toUpperCase()} — ${event.label}${event.detail ? `: ${event.detail}` : ''}`,
              ts: Date.now(),
            }]);
          } else if (event.type === 'log') {
            const lines = event.line.split('\n').filter(l => l.trim());
            for (const line of lines) tracker.appendLog(event.stage, line);
            setPrepareConsole(prev => [...prev, ...lines.map(line => ({ stage: event.stage, line, ts: Date.now() }))]);
          } else if (event.type === 'session') {
            newSessionId = event.id;
          }
        },
        abort.signal,
      );
      if (!newSessionId) {
        throw new Error('Clone finished without producing a session — check server logs.');
      }
      setSessionId(newSessionId);
      setPhase('selecting');
    } catch (err: unknown) {
      setFatalError(err instanceof Error ? err.message : 'Failed to prepare workspace');
      setPhase('error');
    }
  }, [settings]);

  // ── Step 2: audit + export + commit + push against the prepared session ──
  const handleStart = useCallback(async () => {
    if (selections.length === 0 || !sessionId) return;
    setPhase('running');
    setRunStages([]);
    setRunConsole([]);
    setWorkflowResult(null);
    setFatalError(null);
    setPushRetry(null);

    const abort = new AbortController();
    abortRef.current = abort;
    const tracker = makeStageTracker(setRunStages);
    let pushRetryPending = false;

    try {
      await runWorkflow(
        settings,
        { session: sessionId, selections, branchId, skipGit },
        (event: WorkflowEvent) => {
          if (event.type === 'stage') {
            tracker.upsertStage(event);
            setRunConsole(prev => [...prev, {
              stage: event.id,
              line: `${event.status.toUpperCase()} — ${event.label}${event.detail ? `: ${event.detail}` : ''}`,
              ts: Date.now(),
            }]);
          } else if (event.type === 'log') {
            const lines = event.line.split('\n').filter(l => l.trim());
            for (const line of lines) tracker.appendLog(event.stage, line);
            setRunConsole(prev => [...prev, ...lines.map(line => ({ stage: event.stage, line, ts: Date.now() }))]);
          } else if (event.type === 'result') {
            setWorkflowResult(event.result);
          } else if (event.type === 'push-retry') {
            pushRetryPending = true;
            setPushRetry({ branchName: event.branchName, repos: event.repos });
          }
        },
        abort.signal,
      );
      // Keep the session alive if a push still needs retrying; otherwise the
      // server has already dropped it, so drop our reference too.
      if (!pushRetryPending) setSessionId(null);
      setPhase('done');
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        setFatalError('Workflow was cancelled.');
      } else {
        setFatalError(err instanceof Error ? err.message : 'Unexpected error');
      }
      setPhase('error');
    }
  }, [selections, sessionId, branchId, skipGit, settings]);

  // ── Retry a failed push (repeatable until it succeeds) ────────────────────
  const handleRetryPush = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id || retrying) return;
    setRetrying(true);

    const abort = new AbortController();
    abortRef.current = abort;
    const tracker = makeStageTracker(setRunStages);
    let stillPending = false;

    try {
      await retryPushWorkflow(
        settings,
        id,
        (event: WorkflowEvent) => {
          if (event.type === 'stage') {
            tracker.upsertStage(event);
            setRunConsole(prev => [...prev, {
              stage: event.id,
              line: `${event.status.toUpperCase()} — ${event.label}${event.detail ? `: ${event.detail}` : ''}`,
              ts: Date.now(),
            }]);
          } else if (event.type === 'log') {
            const lines = event.line.split('\n').filter(l => l.trim());
            for (const line of lines) tracker.appendLog(event.stage, line);
            setRunConsole(prev => [...prev, ...lines.map(line => ({ stage: event.stage, line, ts: Date.now() }))]);
          } else if (event.type === 'push-retry') {
            stillPending = true;
            setPushRetry({ branchName: event.branchName, repos: event.repos });
          } else if (event.type === 'push-complete') {
            // Merge the freshly-obtained PR URLs into the existing result.
            setWorkflowResult(prev => prev ? {
              ...prev,
              prUrl: event.prUrls['theme_icons'] ?? prev.prUrl,
              luzNextPrUrl: event.prUrls['luz_next'] ?? prev.luzNextPrUrl,
            } : prev);
          }
        },
        abort.signal,
      );
      if (!stillPending) {
        setPushRetry(null);
        setSessionId(null);  // server cleaned up the session on full success
      }
    } catch (err: unknown) {
      setRunConsole(prev => [...prev, {
        stage: 'system',
        line: `Retry push failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        ts: Date.now(),
      }]);
    } finally {
      setRetrying(false);
    }
  }, [settings, retrying]);

  const handleCancel = useCallback(() => {
    // During the run phase the server keeps the process alive independently
    // of this HTTP connection (it performs real git commits/pushes), so
    // aborting the client fetch alone would NOT stop it — we must explicitly
    // ask the server to kill it. The clone phase has no push in flight, so a
    // plain client-side abort is enough there.
    if (phase === 'running' && sessionId) {
      cancelWorkflow(settings, sessionId).catch(() => {});
    }
    abortRef.current?.abort();
  }, [phase, sessionId, settings]);

  const handleReset = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) cleanupWorkflowSession(settings, id).catch(() => {});
    setPhase('ready');
    setSessionId(null);
    setPrepareStages([]);
    setRunStages([]);
    setPrepareConsole([]);
    setRunConsole([]);
    setWorkflowResult(null);
    setFatalError(null);
    setPushRetry(null);
    setSelections([]);
    setBranchId(String(Date.now()));
  }, [settings]);

  const isPreparing = phase === 'preparing';
  const isSelecting = phase === 'selecting';
  const isRunning = phase === 'running';
  const isTerminal = phase === 'done' || phase === 'error';

  return (
    <div className="auto-page">
      {/* Background decoration */}
      <div className="auto-page__bg" aria-hidden="true">
        <div className="auto-page__orb auto-page__orb--1" />
        <div className="auto-page__orb auto-page__orb--2" />
      </div>

      <AnimatePresence mode="wait">
        {phase === 'ready' ? (
          // ── READY PHASE — nothing cloned yet ───────────────────────────────
          <motion.div
            key="ready"
            className="auto-page__section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
          >
            <div className="auto-page__glass-card auto-page__ready-card">
              <h2 className="auto-page__section-title">
                <span className="auto-page__title-icon">⚡</span>
                Automated Icon Workflow
              </h2>
              <p className="auto-page__section-hint">
                We'll clone <code>theme_icons</code> and <code>luz_next</code> first — the
                icon source assets live inside theme_icons, so search only becomes available
                once both repositories are ready.
              </p>
              <motion.button
                className="launch-bar__start-btn"
                onClick={handlePrepare}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <span className="launch-bar__start-icon">⬇</span>
                Clone repositories &amp; start
              </motion.button>
            </div>
          </motion.div>
        ) : isPreparing ? (
          // ── PREPARING PHASE — cloning both repos ───────────────────────────
          <motion.div
            key="preparing"
            className="auto-page__section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
          >
            <div className="auto-page__glass-card auto-page__glass-card--run">
              <div className="auto-page__run-header">
                <div className="auto-page__run-title-row">
                  <div className="auto-page__pulse-dot" />
                  <h2 className="auto-page__run-title">Cloning repositories…</h2>
                </div>
                <button className="auto-page__cancel-btn" onClick={handleCancel}>
                  ✕ Cancel
                </button>
              </div>
              <PipelineTimeline
                stages={prepareStages}
                expandedStage={expandedStage}
                onToggleExpand={handleToggleExpand}
              />
            </div>
            <div className="auto-page__glass-card auto-page__glass-card--run">
              <LiveConsole lines={prepareConsole} title="Live clone log" />
            </div>
          </motion.div>
        ) : isSelecting ? (
          // ── SELECTION PHASE — session ready, search unlocked ───────────────
          <motion.div
            key="selection"
            className="auto-page__section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
          >
            <div className="auto-page__glass-card">
              <h2 className="auto-page__section-title">
                <span className="auto-page__title-icon">⬡</span>
                Select Assets
              </h2>
              <p className="auto-page__section-hint">
                Repositories cloned — search and add icons, duotones, and illustrations to export.
              </p>
              {sessionId && (
                <SelectionSearch
                  settings={settings}
                  sessionId={sessionId}
                  selections={selections}
                  onAdd={handleAdd}
                />
              )}
            </div>

            <div className="auto-page__glass-card">
              <SelectionTray
                settings={settings}
                sessionId={sessionId}
                selections={selections}
                onRemove={handleRemove}
                onClearAll={handleClearAll}
              />
            </div>

            <div className="auto-page__glass-card">
              <LaunchBar
                branchId={branchId}
                onBranchIdChange={setBranchId}
                skipGit={skipGit}
                onSkipGitChange={setSkipGit}
                selectionCount={selections.length}
                onStart={handleStart}
                disabled={isRunning}
              />
            </div>
          </motion.div>
        ) : isRunning ? (
          // ── RUNNING PHASE ─────────────────────────────────────────────────
          <motion.div
            key="running"
            className="auto-page__section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
          >
            <div className="auto-page__glass-card auto-page__glass-card--run">
              <div className="auto-page__run-header">
                <div className="auto-page__run-title-row">
                  <div className="auto-page__pulse-dot" />
                  <h2 className="auto-page__run-title">Workflow running…</h2>
                </div>
                <button className="auto-page__cancel-btn" onClick={handleCancel}>
                  ✕ Cancel
                </button>
              </div>
              <PipelineTimeline
                stages={runStages}
                expandedStage={expandedStage}
                onToggleExpand={handleToggleExpand}
              />
            </div>
            <div className="auto-page__glass-card auto-page__glass-card--run">
              <LiveConsole lines={runConsole} title="Live workflow log" />
            </div>
          </motion.div>
        ) : (
          // ── DONE / ERROR PHASE ────────────────────────────────────────────
          <motion.div
            key="done"
            className="auto-page__section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
          >
            {/* Show the clone timeline too, if it ran, for post-run review */}
            {phase === 'error' && prepareStages.length > 0 && runStages.length === 0 && (
              <div className="auto-page__glass-card auto-page__glass-card--done">
                <h3 className="auto-page__section-title">Clone log</h3>
                <PipelineTimeline
                  stages={prepareStages}
                  expandedStage={expandedStage}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
            )}

            {runStages.length > 0 && (
              <div className="auto-page__glass-card auto-page__glass-card--done">
                <h3 className="auto-page__section-title">Stage log</h3>
                <PipelineTimeline
                  stages={runStages}
                  expandedStage={expandedStage}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
            )}

            {/* Push failed (e.g. network error) but the commit is safe locally —
                offer an unlimited manual retry that re-pushes only what's left. */}
            {pushRetry && (
              <div className="auto-page__glass-card push-retry-card">
                <div className="push-retry-card__body">
                  <span className="push-retry-card__icon">{retrying ? <span className="spin">⟳</span> : '⚠'}</span>
                  <div className="push-retry-card__text">
                    <strong>Push didn’t reach the remote</strong>
                    <span>
                      The commit is safe locally on <code>{pushRetry.branchName}</code>, but pushing{' '}
                      {pushRetry.repos.join(' & ')} failed. Retry until it goes through — nothing is re-cloned or re-exported.
                    </span>
                  </div>
                </div>
                <button
                  className="push-retry-card__btn"
                  onClick={handleRetryPush}
                  disabled={retrying}
                >
                  {retrying ? 'Retrying…' : '↻ Retry push'}
                </button>
              </div>
            )}

            {fatalError && !workflowResult && (
              <div className="auto-page__fatal">
                <span className="auto-page__fatal-icon">✗</span>
                {fatalError}
              </div>
            )}

            {/* Keep the raw log visible after failure/completion for post-mortem tracing. */}
            {(prepareConsole.length > 0 || runConsole.length > 0) && (
              <div className="auto-page__glass-card auto-page__glass-card--done">
                <LiveConsole
                  lines={runConsole.length > 0 ? runConsole : prepareConsole}
                  title={runConsole.length > 0 ? 'Workflow log' : 'Clone log'}
                  defaultOpen={phase === 'error'}
                />
              </div>
            )}

            {workflowResult && (
              <WorkflowResultCard result={workflowResult} onReset={handleReset} />
            )}

            {!workflowResult && (
              <div className="auto-page__glass-card">
                <button className="result-card__reset-btn" onClick={handleReset}>
                  ↩ Start new workflow
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
