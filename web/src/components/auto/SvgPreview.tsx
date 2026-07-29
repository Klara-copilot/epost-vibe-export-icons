/**
 * Lightweight inline SVG preview for the auto-workflow components. Previews
 * are fetched from a prepared workflow session's cloned theme_icons — pass
 * `sessionId={null}` to render a placeholder (e.g. before the session exists).
 *
 * Loading is deferred via IntersectionObserver: with up to 40 search results
 * rendered at once, firing 40 parallel preview requests on mount used to
 * saturate the browser's connection pool and stall the whole list. Now a
 * preview only fetches once its row actually scrolls into view.
 */
import { useEffect, useState, useRef, memo } from 'react';
import type { Pipeline } from '../../state/settings';
import type { Settings } from '../../state/settings';
import { getWorkflowSvgPreview } from '../../api/client';

interface Props {
  settings: Settings;
  sessionId: string | null;
  pipeline: Pipeline;
  name: string;
  sourceLabel?: string;
  size?: number;
  /** Render as an inline element without box background */
  inline?: boolean;
}

const cache = new Map<string, string>();

export const SvgPreview = memo(function SvgPreview({ settings, sessionId, pipeline, name, sourceLabel, size = 52, inline }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const mounted = useRef(true);
  const elRef = useRef<HTMLDivElement | HTMLSpanElement | null>(null);

  // Defer fetching until the preview is actually scrolled near the viewport.
  useEffect(() => {
    const el = elRef.current;
    if (!el || isVisible) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    mounted.current = true;
    if (!sessionId || !isVisible) return;
    const key = `${sessionId}|${pipeline}|${name}|${sourceLabel ?? ''}`;
    if (cache.has(key)) {
      setSvg(cache.get(key)!);
      return;
    }
    getWorkflowSvgPreview(settings, sessionId, pipeline, name, sourceLabel)
      .then(s => {
        cache.set(key, s);
        if (mounted.current) setSvg(s);
      })
      .catch(() => { if (mounted.current) setSvg(null); });
    return () => { mounted.current = false; };
  }, [settings, sessionId, pipeline, name, sourceLabel, isVisible]);

  if (inline) {
    return svg
      ? <span ref={elRef} className="svg-preview svg-preview--inline" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
      : <span ref={elRef} className="svg-preview svg-preview--inline svg-preview--placeholder" style={{ width: size, height: size }} />;
  }

  return (
    <div ref={elRef} className="svg-preview" style={{ width: size, height: size }}>
      {svg
        ? <span dangerouslySetInnerHTML={{ __html: svg }} />
        : <span className="svg-preview__placeholder" />}
    </div>
  );
});
