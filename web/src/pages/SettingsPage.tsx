import type { Pipeline, Settings } from '../state/settings';
import { FolderPicker } from '../components/FolderPicker';

const PIPELINES: { id: Pipeline; label: string }[] = [
  { id: 'icon', label: 'Icon font (Light / Regular / Bold / Glyph)' },
  { id: 'duotone', label: 'Duotone illustrations' },
  { id: 'illustration', label: 'Illustrations' },
];

export function SettingsPage({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <section className="page">
      <h2>Settings</h2>
      <p className="page__hint">
        These are stored only in this browser (<code>localStorage</code>), never sent anywhere
        except to the local bridge server you configure below.
      </p>

      <div className="field">
        <label>Bridge server URL</label>
        <input
          type="text"
          value={settings.serverUrl}
          placeholder="http://localhost:5177"
          onChange={(e) => set('serverUrl', e.target.value)}
        />
      </div>

      <div className="field">
        <label>Bridge server token</label>
        <input
          type="password"
          value={settings.token}
          placeholder="Paste the token printed by `npm run server`"
          onChange={(e) => set('token', e.target.value)}
        />
      </div>

      <div className="field">
        <label>Pipeline</label>
        <select
          value={settings.pipeline}
          onChange={(e) => set('pipeline', e.target.value as Pipeline)}
        >
          {PIPELINES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <FolderPicker
        label="Project root (theme_icons checkout)"
        value={settings.projectRoot}
        onChange={(v) => set('projectRoot', v)}
        settings={settings}
      />

      <FolderPicker
        label="Theme path (klara-theme checkout)"
        value={settings.themePath}
        onChange={(v) => set('themePath', v)}
        settings={settings}
      />
    </section>
  );
}
