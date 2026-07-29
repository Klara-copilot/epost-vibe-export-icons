import { useRef, useState } from 'react';
import { streamExport } from '../api/client';
import type { Settings } from '../state/settings';

type RunState = 'idle' | 'running' | 'done' | 'error';

export function ExportPage({ settings }: { settings: Settings }) {
  const [runState, setRunState] = useState<RunState>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  async function handleExport() {
    setRunState('running');
    setLines([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamExport(
        settings,
        settings.pipeline,
        (line) => setLines((prev) => [...prev, line]),
        controller.signal,
      );
      setRunState('done');
    } catch (err) {
      setLines((prev) => [...prev, err instanceof Error ? err.message : 'Export failed']);
      setRunState('error');
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    setRunState('idle');
  }

  return (
    <section className="page">
      <h2>Export</h2>
      <p className="page__hint">
        Runs the font/sprite export for the <strong>{settings.pipeline}</strong> pipeline. This
        can take a while — output streams below as it runs, same as the CLI.
      </p>

      <div className="field__row">
        <button type="button" onClick={handleExport} disabled={runState === 'running'}>
          {runState === 'running' ? 'Exporting…' : 'Run export'}
        </button>
        {runState === 'running' && (
          <button type="button" onClick={handleCancel}>
            Cancel
          </button>
        )}
      </div>

      <pre className="log-view">
        {lines.length === 0 ? 'No output yet.' : lines.join('\n')}
      </pre>

      {runState === 'done' && <div className="banner banner--success">Export complete.</div>}
      {runState === 'error' && <div className="banner banner--error">Export failed — see log above.</div>}
    </section>
  );
}
