import { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { WorkflowStageEvent, WorkflowLogEvent } from '../../api/types';

interface StageState {
  event: WorkflowStageEvent;
  logs: string[];
}

interface Props {
  stages: StageState[];
  expandedStage: string | null;
  onToggleExpand: (id: string) => void;
}

const STATUS_ICON: Record<string, string> = {
  start: '⟳',
  ok: '✓',
  warn: '⚠',
  error: '✗',
  pending: '○',
};

const STATUS_CLASS: Record<string, string> = {
  start: 'stage-card--active',
  ok: 'stage-card--ok',
  warn: 'stage-card--warn',
  error: 'stage-card--error',
  pending: 'stage-card--pending',
};

export const PipelineTimeline = memo(function PipelineTimeline({
  stages,
  expandedStage,
  onToggleExpand,
}: Props) {
  return (
    <div className="pipeline-timeline">
      <AnimatePresence initial={false}>
        {stages.map(s => (
          <motion.div
            key={s.event.id}
            className={`stage-card ${STATUS_CLASS[s.event.status] ?? ''}`}
            initial={{ opacity: 0, x: -16, height: 0 }}
            animate={{ opacity: 1, x: 0, height: 'auto' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            layout
          >
            <div
              className="stage-card__header"
              role="button"
              tabIndex={0}
              onClick={() => onToggleExpand(s.event.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(s.event.id); }}
            >
              <span className={`stage-card__icon stage-card__icon--${s.event.status}`}>
                {s.event.status === 'start'
                  ? <span className="spin">{STATUS_ICON.start}</span>
                  : STATUS_ICON[s.event.status] ?? '○'}
              </span>
              <div className="stage-card__info">
                <span className="stage-card__label">{s.event.label}</span>
                {s.event.detail && (
                  <span className="stage-card__detail">{s.event.detail}</span>
                )}
              </div>
              {s.logs.length > 0 && (
                <span className="stage-card__log-toggle">
                  {expandedStage === s.event.id ? '▲' : '▼'} {s.logs.length} lines
                </span>
              )}
            </div>

            <AnimatePresence>
              {expandedStage === s.event.id && s.logs.length > 0 && (
                <motion.div
                  className="stage-card__logs"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <pre className="stage-card__log-pre">
                    {s.logs.join('\n')}
                  </pre>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

export type { StageState };
export type { WorkflowLogEvent };
