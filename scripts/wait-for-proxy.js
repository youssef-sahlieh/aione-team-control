import {pathToFileURL} from 'node:url';

export const requiredCapabilities = ['date-requests-v1', 'ticket-notes-v1'];
export function compatibleProxy(data) {
  return data?.ok === true && data.apiVersion === 1 && Array.isArray(data.capabilities) && requiredCapabilities.every(feature => data.capabilities.includes(feature));
}

export async function waitForProxy({url='https://aione-team-proxy.vercel.app/health', timeoutMs=600000, intervalMs=10000, fetchImpl=fetch, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), now=Date.now, log=console.log}={}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(url, {cache:'no-store', signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-now())))});
      if (response.ok && compatibleProxy(await response.json())) {
        log('Production proxy supports date requests and internal notes.');
        return;
      }
    } catch { /* An old deployment or transient network failure may become ready on the next check. */ }
    log('Waiting for the existing Vercel Git deployment to become ready…');
    if (now() < deadline) await sleep(Math.min(intervalMs,deadline-now()));
  }
  throw new Error('Production proxy is not ready. Check the Vercel Git deployment: repository, production branch main, Root Directory proxy, deployment errors and production domain. See docs/github-deployment.md.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await waitForProxy(); } catch(error) {console.error(error.message); process.exitCode=1;}
}
