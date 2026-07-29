import { useEffect, useRef, useState } from 'react';
import { register, search } from '../api/client';
import { IconPreview } from '../components/IconPreview';
import type { Settings } from '../state/settings';
import type { SearchResult } from '../api/types';

export function SearchRegisterPage({
  settings,
  staged,
  onRegistered,
}: {
  settings: Settings;
  staged: string[];
  onRegistered: (name: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (!term.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await search(settings, settings.pipeline, term.trim());
        setResults(res.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, settings.pipeline]);

  async function handleRegister(name: string) {
    setError(null);
    try {
      const res = await register(settings, settings.pipeline, name);
      if (res.registered) {
        onRegistered(name);
      } else {
        setError(res.reason ?? `Could not register "${name}"`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Register failed');
    }
  }

  return (
    <section className="page">
      <h2>Search &amp; Register</h2>
      <p className="page__hint">
        Search source SVGs for the current pipeline ({settings.pipeline}) and register the ones
        you want added.
      </p>

      <div className="field">
        <label>Search</label>
        <input
          type="text"
          value={term}
          placeholder="e.g. Lock Shield"
          onChange={(e) => setTerm(e.target.value)}
          autoFocus
        />
      </div>

      {searching && <p className="page__hint">Searching…</p>}
      {error && <div className="banner banner--error">{error}</div>}

      <ul className="result-list">
        {results.map((r) => (
          <li key={`${r.name}-${r.sourceLabel ?? ''}`} className="result-list__item">
            <IconPreview
              settings={settings}
              pipeline={settings.pipeline}
              name={r.name}
              sourceLabel={r.sourceLabel}
            />
            <span className="result-list__label">
              {r.name}
              {r.sourceLabel && <span className="result-list__source"> · {r.sourceLabel}</span>}
              {r.matchedStyles && (
                <span className="result-list__source"> · {r.matchedStyles.join(', ')}</span>
              )}
            </span>
            <button type="button" onClick={() => handleRegister(r.name)} disabled={staged.includes(r.name)}>
              {staged.includes(r.name) ? 'Registered' : 'Register'}
            </button>
          </li>
        ))}
        {!searching && term.trim() && results.length === 0 && (
          <li className="result-list__empty">No matches found.</li>
        )}
      </ul>

      {staged.length > 0 && (
        <div className="staged">
          <h3>Staged this session</h3>
          <ul>
            {staged.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
