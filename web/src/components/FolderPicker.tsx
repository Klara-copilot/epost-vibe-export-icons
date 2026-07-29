import { useState } from 'react';
import { browse, pickFolder } from '../api/client';
import type { Settings } from '../state/settings';
import type { BrowseEntry } from '../api/types';

export function FolderPicker({
  label,
  value,
  onChange,
  settings,
}: {
  label: string;
  value: string;
  onChange: (path: string) => void;
  settings: Settings;
}) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(value || '');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);

  async function loadPath(path: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await browse(settings, path);
      setBrowsePath(res.path);
      setEntries(res.entries.filter((e) => e.isDirectory));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse folder');
    } finally {
      setLoading(false);
    }
  }

  async function handleBrowseClick() {
    setPicking(true);
    setError(null);
    try {
      const result = await pickFolder(settings, value);
      if (result.status === 'ok') {
        onChange(result.path);
        return;
      }
      if (result.status === 'cancelled') {
        return;
      }
      // 'unavailable' — no native dialog on this machine, fall back to the
      // in-app directory browser below.
      setOpen(true);
      loadPath(value || '.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open folder picker');
      setOpen(true);
      loadPath(value || '.');
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="field__row">
        <input
          type="text"
          value={value}
          placeholder="/absolute/path or ~/relative/to/home"
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" onClick={handleBrowseClick} disabled={picking}>
          {picking ? 'Opening…' : 'Browse…'}
        </button>
      </div>

      {open && (
        <div className="folder-picker">
          <div className="folder-picker__path">{loading ? 'Loading…' : browsePath}</div>
          {error && <div className="folder-picker__error">{error}</div>}
          <ul className="folder-picker__list">
            <li>
              <button type="button" onClick={() => loadPath(`${browsePath}/..`)}>
                .. (up)
              </button>
            </li>
            {entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => loadPath(entry.path)}>
                  {entry.name}/
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="folder-picker__select"
            onClick={() => {
              onChange(browsePath);
              setOpen(false);
            }}
          >
            Use this folder
          </button>
        </div>
      )}
    </div>
  );
}
