/**
 * CORS-proxy-aware HTTP client for isomorphic-git.
 *
 * Wraps the standard isomorphic-git/http/web module to route
 * requests through a Cloudflare Worker proxy, avoiding browser
 * CORS restrictions when talking to github.com.
 *
 * Usage:
 *   import { makeProxyHttp } from './proxy-http';
 *   const http = makeProxyHttp('https://my-worker.workers.dev');
 *   await git.clone({ fs, http, ... });
 */

import _http from 'isomorphic-git/http/web';

/**
 * Create an isomorphic-git compatible HTTP client that routes
 * github.com requests through the CORS proxy.
 *
 * @param proxyBaseUrl - The base URL of the proxy worker,
 *                       e.g. "https://wiki3-ai-sync-proxy.you.workers.dev"
 *                       If empty/null, requests go directly (for testing).
 */
export function makeProxyHttp(proxyBaseUrl?: string | null) {
  return {
    async request(config: { url: string; [key: string]: any }) {
      let { url } = config;

      // Rewrite github.com URLs to go through the proxy
      if (proxyBaseUrl && url.startsWith('https://github.com/')) {
        const path = url.slice('https://github.com/'.length);
        url = `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${path}`;
      }

      return _http.request({ ...config, url });
    },
  };
}

/**
 * The default proxy URL. Override via localStorage or env.
 * Users can set `localStorage.setItem('jl-deploy-proxy', 'https://...')`
 * to use a custom proxy.
 */
export function getProxyUrl(): string {
  if (typeof localStorage !== 'undefined') {
    const custom = localStorage.getItem('jl-deploy-proxy');
    if (custom) return custom;
  }
  // Default — users must deploy their own worker and set this
  return '';
}
