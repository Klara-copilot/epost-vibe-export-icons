import { useState } from 'react';
import { deploy } from '../api/client';
import type { Settings } from '../state/settings';
import type { DeployResponse } from '../api/types';

type DeployState = 'idle' | 'confirming' | 'running' | 'done' | 'error';

export function DeployPage({ settings, staged }: { settings: Settings; staged: string[] }) {
  const [state, setState] = useState<DeployState>('idle');
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDeploy() {
    setState('running');
    setError(null);
    try {
      const res = await deploy(settings, settings.pipeline, staged);
      setResult(res);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed');
      setState('error');
    }
  }

  return (
    <section className="page">
      <h2>Deploy</h2>
      <p className="page__hint">
        Copies the exported files from <strong>{settings.pipeline}</strong> into{' '}
        <code>{settings.themePath || '(theme path not set)'}</code>, then commits and pushes a
        branch — same as <code>scripts/workflow.js</code>.
      </p>

      <p className="page__hint">
        {staged.length > 0
          ? `Registered this session: ${staged.join(', ')}`
          : 'Nothing registered this session yet — go to Search & Register first.'}
      </p>

      {state !== 'confirming' && state !== 'running' && (
        <button
          type="button"
          onClick={() => setState('confirming')}
          disabled={!settings.themePath || staged.length === 0}
        >
          Deploy to theme
        </button>
      )}

      {state === 'confirming' && (
        <div className="banner banner--warning">
          <p>
            This will copy files into <code>{settings.themePath}</code> and push a git branch.
            Continue?
          </p>
          <div className="field__row">
            <button type="button" onClick={handleDeploy}>
              Yes, deploy
            </button>
            <button type="button" onClick={() => setState('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {state === 'running' && <p className="page__hint">Deploying…</p>}

      {state === 'done' && result && (
        <div className="banner banner--success">
          <p>Deployed to branch {result.branch} (commit {result.commit}).</p>
          {result.prUrl && (
            <p>
              <a href={result.prUrl} target="_blank" rel="noreferrer">
                View pull request
              </a>
            </p>
          )}
        </div>
      )}

      {state === 'error' && <div className="banner banner--error">{error}</div>}
    </section>
  );
}
