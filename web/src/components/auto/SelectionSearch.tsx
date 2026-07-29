import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Settings } from '../../state/settings';
import type { Pipeline } from '../../state/settings';
import type { SearchResult, WorkflowSelection } from '../../api/types';
import { searchWorkflowSession } from '../../api/client';
import { SvgPreview } from './SvgPreview';

interface Props {
  settings: Settings;
  sessionId: string;
  selections: WorkflowSelection[];
  onAdd: (sel: WorkflowSelection) => void;
}

const PIPELINES: { value: Pipeline; label: string; emoji: string }[] = [
  { value: 'icon', label: 'Icons', emoji: '⬡' },
  { value: 'duotone', label: 'Duotone', emoji: '◑' },
  { value: 'illustration', label: 'Illustrations', emoji: '🎨' },
];

export function SelectionSearch({ settings, sessionId, selections, onAdd }: Props) {
  const [pipeline, setPipeline] = useState<Pipeline>('icon');
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (p: Pipeline, t: string) => {
      if (!t.trim()) { setResults([]); return; }
      setLoading(true);
      setError(null);
      try {
        const res = await searchWorkflowSession(settings, sessionId, p, t);
        setResults(res.results);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [settings, sessionId],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(pipeline, term), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [term, pipeline, doSearch]);

  function isSelected(name: string) {
    return selections.some(s => s.pipeline === pipeline && s.name === name);
  }

  return (
    <div className="sel-search">
      {/* Pipeline tabs */}
      <div className="sel-search__tabs">
        {PIPELINES.map(p => (
          <button
            key={p.value}
            className={`sel-search__tab ${pipeline === p.value ? 'sel-search__tab--active' : ''}`}
            onClick={() => { setPipeline(p.value); setResults([]); setTerm(''); }}
          >
            <span className="sel-search__tab-emoji">{p.emoji}</span> {p.label}
          </button>
        ))}
      </div>

      {/* Search input */}
      <div className="sel-search__input-wrap">
        <span className="sel-search__icon">
          {loading ? <span className="spin">⟳</span> : '⌕'}
        </span>
        <input
          className="sel-search__input"
          type="text"
          placeholder={`Search ${pipeline} names…`}
          value={term}
          onChange={e => setTerm(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {term && (
          <button className="sel-search__clear" onClick={() => { setTerm(''); setResults([]); }} aria-label="Clear">×</button>
        )}
      </div>

      {/* Error */}
      {error && <div className="sel-search__error">{error}</div>}

      {/* Results */}
      <AnimatePresence>
        {results.length > 0 && (
          <motion.ul
            className="sel-search__results"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {results.map(r => {
              const selected = isSelected(r.name);
              return (
                <motion.li
                  key={r.name}
                  className={`sel-search__result ${selected ? 'sel-search__result--selected' : ''}`}
                  layout
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.12 }}
                >
                  <SvgPreview settings={settings} sessionId={sessionId} pipeline={pipeline} name={r.name} sourceLabel={r.sourceLabel} />
                  <div className="sel-search__result-info">
                    <span className="sel-search__result-name">{r.name}</span>
                    {r.sourceLabel && <span className="sel-search__result-sub">{r.sourceLabel}</span>}
                    {r.matchedStyles && r.matchedStyles.length > 0 && (
                      <span className="sel-search__result-sub">{r.matchedStyles.join(', ')}</span>
                    )}
                  </div>
                  <button
                    className={`sel-search__add-btn ${selected ? 'sel-search__add-btn--done' : ''}`}
                    disabled={selected}
                    onClick={() => onAdd({ pipeline, name: r.name })}
                  >
                    {selected ? '✓ Added' : '+ Add'}
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
        {results.length === 0 && term.trim() && !loading && !error && (
          <motion.p
            className="sel-search__empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            No results for "{term}" in {pipeline}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
