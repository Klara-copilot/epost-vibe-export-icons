import { useState } from 'react';
import { Toaster } from 'sonner';
import { loadSettings, saveSettings } from './state/settings';
import { useBridgeStatus } from './hooks/useBridgeStatus';
import { BridgeStatusBanner } from './components/BridgeStatusBanner';
import { StepNav, type Step } from './components/StepNav';
import { SettingsPage } from './pages/SettingsPage';
import { SearchRegisterPage } from './pages/SearchRegisterPage';
import { ExportPage } from './pages/ExportPage';
import { DeployPage } from './pages/DeployPage';
import { AutoWorkflowPage } from './pages/AutoWorkflowPage';

type AppMode = 'auto' | 'wizard';

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [step, setStep] = useState<Step>('settings');
  const [staged, setStaged] = useState<string[]>([]);
  const [mode, setMode] = useState<AppMode>('auto');
  const bridgeStatus = useBridgeStatus(settings);

  function handleSettingsChange(next: typeof settings) {
    setSettings(next);
    saveSettings(next);
  }

  // Registered names reset when switching pipeline — they belong to a
  // specific pipeline's export/deploy run, not the session as a whole.
  function handlePipelineChange(next: typeof settings) {
    if (next.pipeline !== settings.pipeline) setStaged([]);
    handleSettingsChange(next);
  }

  return (
    <>
      <Toaster richColors position="top-right" theme="dark" />

      {mode === 'auto' ? (
        /* Auto mode is full-bleed — no .app container, no page header */
        <div className="mc-root">
          {/* Floating HUD — top bar, always visible over the canvas */}
          <header className="mc-hud">
            <span className="mc-hud__brand">
              <span className="mc-hud__brand-dot" />
              Icon Ship
            </span>
            <BridgeStatusBanner status={bridgeStatus} />
            <div className="mc-hud__mode-switch">
              <button
                className="mc-hud__mode-btn mc-hud__mode-btn--active"
                disabled
              >⚡ Auto</button>
              <button
                className="mc-hud__mode-btn"
                onClick={() => setMode('wizard')}
              >🧙 Wizard</button>
            </div>
          </header>
          <AutoWorkflowPage settings={settings} />
        </div>
      ) : (
        <div className="app">
          <header className="app__header">
            <div className="app__header-top">
              <div>
                <h1>Icon Export</h1>
                <p>Search, register, export, and deploy Streamline icons.</p>
              </div>
              <div className="app__mode-switch">
                <button
                  className="app__mode-btn"
                  onClick={() => setMode('auto')}
                >⚡ Auto</button>
                <button className="app__mode-btn app__mode-btn--active" disabled>
                  🧙 Wizard
                </button>
              </div>
            </div>
          </header>
          <BridgeStatusBanner status={bridgeStatus} />
          <StepNav current={step} onSelect={setStep} />
          <main className="app__main">
            {step === 'settings' && (
              <SettingsPage settings={settings} onChange={handlePipelineChange} />
            )}
            {step === 'search' && (
              <SearchRegisterPage settings={settings} staged={staged} onRegistered={(name) => setStaged((prev) => [...prev, name])} />
            )}
            {step === 'export' && <ExportPage settings={settings} />}
            {step === 'deploy' && <DeployPage settings={settings} staged={staged} />}
          </main>
        </div>
      )}
    </>
  );
}
