import { useState } from 'react';
import { motion } from 'framer-motion';

interface Props {
  branchId: string;
  onBranchIdChange: (id: string) => void;
  skipGit: boolean;
  onSkipGitChange: (skip: boolean) => void;
  selectionCount: number;
  onStart: () => void;
  disabled: boolean;
}

export function LaunchBar({
  branchId,
  onBranchIdChange,
  skipGit,
  onSkipGitChange,
  selectionCount,
  onStart,
  disabled,
}: Props) {
  const [manual, setManual] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const previewBranchName = `feature/export-icons-${branchId}`;

  return (
    <div className="launch-bar">
      {/* Branch control */}
      <div className="launch-bar__branch">
        <div className="launch-bar__branch-label">
          <span>Branch</span>
          <button
            className="launch-bar__branch-toggle"
            onClick={() => setManual(m => !m)}
          >
            {manual ? 'Auto' : 'Manual'}
          </button>
        </div>
        {manual ? (
          <input
            className="launch-bar__branch-input"
            type="text"
            value={branchId}
            onChange={e => onBranchIdChange(e.target.value.replace(/[^a-zA-Z0-9._-]/g, '-'))}
            placeholder="branch-id"
            maxLength={80}
          />
        ) : (
          <code className="launch-bar__branch-preview">{previewBranchName}</code>
        )}
      </div>

      {/* Dry-run toggle */}
      <label className="launch-bar__dry-run">
        <input
          type="checkbox"
          checked={skipGit}
          onChange={e => onSkipGitChange(e.target.checked)}
        />
        <span>Dry run (skip git push)</span>
      </label>

      {/* CTA */}
      <div className="launch-bar__cta">
        {!confirming ? (
          <motion.button
            className="launch-bar__start-btn"
            disabled={disabled || selectionCount === 0}
            onClick={() => setConfirming(true)}
            whileHover={{ scale: disabled ? 1 : 1.02 }}
            whileTap={{ scale: disabled ? 1 : 0.98 }}
          >
            <span className="launch-bar__start-icon">⚡</span>
            Run Workflow
            {selectionCount > 0 && <span className="launch-bar__badge">{selectionCount}</span>}
          </motion.button>
        ) : (
          <motion.div
            className="launch-bar__confirm"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <span className="launch-bar__confirm-text">
              {skipGit
                ? 'Dry-run: export without pushing. Confirm?'
                : `This will push to ${previewBranchName}. Confirm?`}
            </span>
            <button
              className="launch-bar__confirm-yes"
              onClick={() => { setConfirming(false); onStart(); }}
            >
              Yes, go
            </button>
            <button
              className="launch-bar__confirm-no"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
