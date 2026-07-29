import { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { WorkflowSelection } from '../../api/types';
import type { Pipeline, Settings } from '../../state/settings';
import { SvgPreview } from './SvgPreview';

interface Props {
  settings: Settings;
  sessionId: string | null;
  selections: WorkflowSelection[];
  onRemove: (index: number) => void;
  onClearAll: () => void;
}

const PIPELINE_COLOR: Record<Pipeline, string> = {
  icon: '#7c3aed',
  duotone: '#0ea5e9',
  illustration: '#10b981',
};

export const SelectionTray = memo(function SelectionTray({ settings, sessionId, selections, onRemove, onClearAll }: Props) {
  return (
    <div className="sel-tray">
      <div className="sel-tray__header">
        <span className="sel-tray__count">
          {selections.length === 0
            ? 'No assets selected'
            : `${selections.length} asset${selections.length !== 1 ? 's' : ''} selected`}
        </span>
        {selections.length > 0 && (
          <button className="sel-tray__clear-all" onClick={onClearAll}>Clear all</button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {selections.length === 0 ? (
          <motion.div
            key="empty"
            className="sel-tray__empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            Search above and add icons, duotones, or illustrations to export.
          </motion.div>
        ) : (
          <motion.div key="chips" className="sel-tray__chips">
            {selections.map((sel, idx) => (
              <motion.div
                key={`${sel.pipeline}:${sel.name}:${idx}`}
                className="sel-chip"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                layout
              >
                <SvgPreview settings={settings} sessionId={sessionId} pipeline={sel.pipeline} name={sel.name} size={28} inline />
                <span
                  className="sel-chip__badge"
                  style={{ background: PIPELINE_COLOR[sel.pipeline] }}
                >
                  {sel.pipeline[0].toUpperCase()}
                </span>
                <span className="sel-chip__name">{sel.name}</span>
                <button
                  className="sel-chip__remove"
                  onClick={() => onRemove(idx)}
                  aria-label={`Remove ${sel.name}`}
                >×</button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
