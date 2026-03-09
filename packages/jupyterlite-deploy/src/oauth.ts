/**
 * GitHub OAuth Device Flow for browser-based authentication.
 *
 * The Device Flow doesn't require redirects, making it ideal for
 * static sites like JupyterLite on GitHub Pages.
 *
 * Flow:
 *   1. POST /oauth/device → get user_code + verification_uri
 *   2. User opens verification_uri, enters user_code
 *   3. Poll POST /oauth/token until access_token is returned
 *
 * The proxy worker handles communication with GitHub's OAuth endpoints
 * (which also have CORS restrictions).
 */

export interface IOAuthConfig {
  /** Base URL of the CORS proxy worker */
  proxyUrl: string;
  /** Requested OAuth scope (default: "public_repo") */
  scope?: string;
}

export interface IDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface IOAuthResult {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * Start the Device Flow: request a device code from the proxy.
 */
export async function requestDeviceCode(
  config: IOAuthConfig
): Promise<IDeviceCodeResponse> {
  const resp = await fetch(`${config.proxyUrl}/oauth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: config.scope ?? 'public_repo' }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Device code request failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

/**
 * Poll for the access token. Returns when the user authorizes,
 * or throws on timeout/error.
 *
 * @param config - OAuth config
 * @param deviceCode - The device_code from requestDeviceCode
 * @param interval - Polling interval in seconds (from the device code response)
 * @param expiresIn - Expiration in seconds (from the device code response)
 * @param onProgress - Optional callback for status updates
 * @param signal - Optional AbortSignal to cancel polling
 */
export async function pollForToken(
  config: IOAuthConfig,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<IOAuthResult> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = Math.max(interval, 5) * 1000; // at least 5s

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('OAuth flow cancelled');
    }

    await sleep(pollInterval);

    const resp = await fetch(`${config.proxyUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    const data = await resp.json() as Record<string, string>;

    if (data.access_token) {
      return data as unknown as IOAuthResult;
    }

    if (data.error === 'authorization_pending') {
      onProgress?.('Waiting for authorization…');
      continue;
    }

    if (data.error === 'slow_down') {
      // GitHub asked us to slow down — add 5s
      pollInterval += 5000;
      onProgress?.('Slowing down polling…');
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Authorization was denied by the user.');
    }

    if (data.error) {
      throw new Error(`OAuth error: ${data.error} — ${data.error_description ?? ''}`);
    }
  }

  throw new Error('Device code expired (timeout). Please try again.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get a cached token from sessionStorage, or null.
 */
export function getCachedToken(): string | null {
  if (typeof sessionStorage !== 'undefined') {
    return sessionStorage.getItem('jl-deploy-token') || null;
  }
  return null;
}

/**
 * Cache a token in sessionStorage (cleared when tab closes).
 */
export function cacheToken(token: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('jl-deploy-token', token);
  }
}
