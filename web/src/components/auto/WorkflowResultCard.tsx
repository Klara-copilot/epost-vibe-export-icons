import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import type { WorkflowResult } from '../../api/types';

interface Props {
  result: WorkflowResult;
  onReset: () => void;
}

export const WorkflowResultCard = memo(function WorkflowResultCard({ result, onReset }: Props) {
  const [showDiff, setShowDiff] = useState(false);

  const totalExported = Object.values(result.pipelines).reduce(
    (sum, p) => sum + p.exported.length, 0,
  );
  const totalAlready = Object.values(result.pipelines).reduce(
    (sum, p) => sum + p.alreadyDone.length, 0,
  );
  const totalFailed = Object.values(result.pipelines).reduce(
    (sum, p) => sum + p.failed.length, 0,
  );

  const statusClass = result.status === 'success'
    ? 'result-card--success'
    : result.status === 'partial'
      ? 'result-card--warn'
      : 'result-card--error';

  const statusIcon = result.status === 'success' ? '✓' : result.status === 'partial' ? '⚠' : '✗';
  const statusLabel = result.status === 'success'
    ? 'Workflow completed successfully'
    : result.status === 'partial'
      ? 'Workflow completed with some failures'
      : 'Workflow failed';

  return (
    <motion.div
      className={`result-card ${statusClass}`}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 250, damping: 28 }}
    >
      {/* Status header */}
      <div className="result-card__header">
        <span className="result-card__status-icon">{statusIcon}</span>
        <div>
          <h3 className="result-card__title">{statusLabel}</h3>
          {result.error && <p className="result-card__error">{result.error}</p>}
        </div>
      </div>

      {/* Stats */}
      <div className="result-card__stats">
        <div className="result-card__stat">
          <span className="result-card__stat-num">{totalExported}</span>
          <span className="result-card__stat-label">exported</span>
        </div>
        <div className="result-card__stat">
          <span className="result-card__stat-num">{totalAlready}</span>
          <span className="result-card__stat-label">skipped</span>
        </div>
        <div className={`result-card__stat ${totalFailed > 0 ? 'result-card__stat--fail' : ''}`}>
          <span className="result-card__stat-num">{totalFailed}</span>
          <span className="result-card__stat-label">failed</span>
        </div>
      </div>

      {/* PR links */}
      {(result.prUrl || result.luzNextPrUrl) && (
        <div className="result-card__prs">
          <p className="result-card__pr-label">Open pull requests</p>
          {result.prUrl && (
            <a className="result-card__pr-link" href={result.prUrl} target="_blank" rel="noopener noreferrer">
              <span className="result-card__pr-repo">theme_icons</span>
              <span className="result-card__pr-branch">{result.branchName}</span>
              <span className="result-card__pr-arrow">→</span>
            </a>
          )}
          {result.luzNextPrUrl && (
            <a className="result-card__pr-link" href={result.luzNextPrUrl} target="_blank" rel="noopener noreferrer">
              <span className="result-card__pr-repo">luz_next</span>
              <span className="result-card__pr-branch">{result.luzNextBranchName}</span>
              <span className="result-card__pr-arrow">→</span>
            </a>
          )}
        </div>
      )}

      {/* Per-pipeline detail */}
      {(['icon', 'duotone', 'illustration'] as const).map(p => {
        const pl = result.pipelines[p];
        if (pl.exported.length + pl.alreadyDone.length + pl.failed.length === 0) return null;
        return (
          <details key={p} className="result-card__pipeline">
            <summary className="result-card__pipeline-summary">
              <span className="result-card__pipeline-name">{p}</span>
              {pl.exported.length > 0 && <span className="result-card__pill result-card__pill--ok">{pl.exported.length} exported</span>}
              {pl.alreadyDone.length > 0 && <span className="result-card__pill result-card__pill--skip">{pl.alreadyDone.length} skipped</span>}
              {pl.failed.length > 0 && <span className="result-card__pill result-card__pill--fail">{pl.failed.length} failed</span>}
            </summary>
            <ul className="result-card__names">
              {pl.exported.map(n => <li key={n} className="result-card__name result-card__name--ok">✓ {n}</li>)}
              {pl.alreadyDone.map(n => <li key={n} className="result-card__name result-card__name--skip">– {n}</li>)}
              {pl.failed.map(n => <li key={n} className="result-card__name result-card__name--fail">✗ {n}</li>)}
            </ul>
          </details>
        );
      })}

      {/* SCSS diff */}
      {result.diff && (
        <div className="result-card__diff-section">
          <button className="result-card__diff-toggle" onClick={() => setShowDiff(s => !s)}>
            {showDiff ? '▲ Hide' : '▼ Show'} SCSS diff
          </button>
          {showDiff && (
            <motion.pre
              className="result-card__diff"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              {result.diff}
            </motion.pre>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="result-card__actions">
        <button className="result-card__reset-btn" onClick={onReset}>
          ↩ Start new workflow
        </button>
      </div>
    </motion.div>
  );
});
