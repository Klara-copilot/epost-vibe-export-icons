export type Pipeline = 'icon' | 'duotone' | 'illustration';

export interface Settings {
  serverUrl: string;
  token: string;
  projectRoot: string;
  themePath: string;
  pipeline: Pipeline;
}

const STORAGE_KEY = 'vibe-icon.settings';

const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://localhost:5177',
  token: '',
  projectRoot: '',
  themePath: '',
  pipeline: 'icon',
};

export function loadSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
