import { memo, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface ConsoleLine {
  stage: string;
  line: string;
  ts: number;
}

interface Props {
  lines: ConsoleLine[];
  /** Default expanded state; the user can still toggle it manually. */
  defaultOpen?: boolean;
  title?: string;
}

/**
 * Always-visible raw log tail, so failures that happen before any stage card
 * exists (e.g. argument validation, an immediate crash) are still traceable.
 * Auto-scrolls to the newest line unless the user has scrolled up manually.
 */
export const LiveConsole = memo(function LiveConsole({ lines, defaultOpen = true, title = 'Live log' }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, open, autoScroll]);

  function handleScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 40);
  }

  return (
    <div className="live-console">
      <button
        className="live-console__header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="live-console__title">
          <span className="live-console__dot" />
          {title}
          {lines.length > 0 && <span className="live-console__count">{lines.length}</span>}
        </span>
        <span className="live-console__toggle">{open ? '▲ Hide' : '▼ Show'}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="live-console__body"
            ref={bodyRef}
            onScroll={handleScroll}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 260, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {lines.length === 0 ? (
              <div className="live-console__empty">Waiting for output…</div>
            ) : (
              lines.map((l, i) => (
                <div key={i} className="live-console__line">
                  <span className="live-console__stage">[{l.stage}]</span> {l.line}
                </div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
