// deploy/core/health.mjs — asking a server what it is. /version names the
// code (release stamp, pid); /bootstrap.json proves an nvk-server answers.
import http from 'node:http';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a candidate release gets to come up before the deploy fails. */
export const HEALTH_TIMEOUT_MS = 90_000;

/** GET a JSON document; null on any error, timeout or non-JSON body. */
export function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

/** GET a text body (the shell page check); null on any error. */
export function getText(url) {
  return new Promise((resolve) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', () => resolve(null));
  });
}

/**
 * Poll /version until it reports exactly `commit`, or give up. Matching the
 * commit — not just answering — is the health bar: an old server still
 * shutting down, or a rollback, must never pass as the new release.
 * @returns {Promise<object|null>} the /version document, or null on timeout
 */
export async function waitHealthy(port, commit, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await getJson(`http://127.0.0.1:${port}/version`);
    if (version?.release?.commit === commit) return version;
    await sleep(500);
  }
  return null;
}

/**
 * Poll /bootstrap.json until an nvk-server answers, or give up. This is the
 * compatibility health check for restoring the pre-deploy launchd job, whose
 * server predates /version and therefore has no release commit to match.
 * @param {number} port loopback port to probe
 * @param {number} [timeoutMs=HEALTH_TIMEOUT_MS] maximum wait in milliseconds
 * @returns {Promise<object|null>} the bootstrap document, or null on timeout
 */
export async function waitBootstrapHealthy(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bootstrap = await getJson(`http://127.0.0.1:${port}/bootstrap.json`);
    if (typeof bootstrap?.wsUrl === 'string' && typeof bootstrap?.protocolVersion === 'number') {
      return bootstrap;
    }
    await sleep(500);
  }
  return null;
}
