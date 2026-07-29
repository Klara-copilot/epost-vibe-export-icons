import { useEffect, useState } from 'react';
import { getStatus } from '../api/client';
import type { Settings } from '../state/settings';

export type BridgeStatus = 'checking' | 'online' | 'offline';

export function useBridgeStatus(settings: Settings, pollMs = 5000): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>('checking');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      if (!settings.serverUrl) {
        setStatus('offline');
        return;
      }
      try {
        await getStatus(settings);
        if (!cancelled) setStatus('online');
      } catch {
        if (!cancelled) setStatus('offline');
      }
    }

    check();
    const id = setInterval(check, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Only serverUrl/token affect connectivity; other settings fields change per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.serverUrl, settings.token, pollMs]);

  return status;
}
