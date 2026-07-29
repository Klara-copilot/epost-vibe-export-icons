import { useEffect, useState } from 'react';
import { getSvgPreview } from '../api/client';
import type { Pipeline, Settings } from '../state/settings';

// Dedupe fetches across re-renders — search results re-render on every
// keystroke (debounced), so without this the same row would refetch its
// preview repeatedly as the user keeps typing.
const previewCache = new Map<string, Promise<string>>();

function svgToDataUri(svgText: string): string {
  const base64 = btoa(unescape(encodeURIComponent(svgText)));
  return `data:image/svg+xml;base64,${base64}`;
}

export function IconPreview({
  settings,
  pipeline,
  name,
  sourceLabel,
}: {
  settings: Settings;
  pipeline: Pipeline;
  name: string;
  sourceLabel?: string;
}) {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const key = `${settings.serverUrl}|${pipeline}|${name}|${sourceLabel ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    setDataUri(null);
    setFailed(false);

    let promise = previewCache.get(key);
    if (!promise) {
      promise = getSvgPreview(settings, pipeline, name, sourceLabel);
      previewCache.set(key, promise);
    }

    promise
      .then((svgText) => {
        if (!cancelled) setDataUri(svgToDataUri(svgText));
      })
      .catch(() => {
        previewCache.delete(key);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (failed) {
    return <div className="icon-preview icon-preview--empty" title="No preview available" />;
  }
  if (!dataUri) {
    return <div className="icon-preview icon-preview--loading" />;
  }
  return <img className="icon-preview" src={dataUri} alt="" width={32} height={32} />;
}
