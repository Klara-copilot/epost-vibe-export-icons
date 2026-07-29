import type { BridgeStatus } from '../hooks/useBridgeStatus';

export function BridgeStatusBanner({ status }: { status: BridgeStatus }) {
  if (status === 'online') return null;

  return (
    <div className="banner banner--warning">
      {status === 'checking' ? (
        <p>Checking connection to the local bridge server…</p>
      ) : (
        <>
          <p>
            <strong>Can't reach the local bridge server.</strong> The icon-export tool runs
            file operations on your machine, so this UI needs a small local server running
            alongside it.
          </p>
          <p>
            Start it with <code>npm run server</code> in the project folder, then confirm the
            server URL and token on the Settings page.
          </p>
        </>
      )}
    </div>
  );
}
