// Uploads the release zip to the Chrome Web Store and Edge Add-ons and submits
// it for review. A store is skipped when its credentials are not set. Listings
// (text, images, privacy answers) are edited in the dashboards; the stores'
// APIs only take packages. Used by .github/workflows/release.yml.
//
//   node scripts/publish-stores.mjs <zip>
//
// Chrome Web Store (API v2, service account):
//   CWS_SERVICE_ACCOUNT_JSON  service account key (JSON); the account is added in
//                             the developer dashboard under Account
//   CWS_PUBLISHER_ID, CWS_ITEM_ID
// Edge Add-ons (API v1.1):
//   EDGE_CLIENT_ID, EDGE_API_KEY  from Partner Center > Publish API
//   EDGE_PRODUCT_ID
//   EDGE_CERTIFICATION_NOTES      notes for certification (required with every submission)

import { createSign } from 'node:crypto';
import fs from 'node:fs';

const zipPath = process.argv[2];
if (!zipPath || !fs.existsSync(zipPath)) throw new Error(`usage: publish-stores.mjs <zip> (got ${zipPath})`);
const zip = fs.readFileSync(zipPath);
const env = (k) => process.env[k]?.trim() || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(what, url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 2000)}`);
  return { res, json: text ? JSON.parse(text) : {} };
}

// ---------------------------------------------------------------- Chrome Web Store

async function googleToken(keyJson) {
  const key = JSON.parse(keyJson);
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key.client_email, scope: 'https://www.googleapis.com/auth/chromewebstore', aud: key.token_uri, iat: now, exp: now + 3600 };
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` });
  const { json } = await call('Google token', key.token_uri, { method: 'POST', body });
  return json.access_token;
}

async function chrome() {
  const [keyJson, publisher, item] = [env('CWS_SERVICE_ACCOUNT_JSON'), env('CWS_PUBLISHER_ID'), env('CWS_ITEM_ID')];
  if (!keyJson || !publisher || !item) return console.log('Chrome Web Store: credentials not set, skipped');
  const auth = { Authorization: `Bearer ${await googleToken(keyJson)}` };
  const name = `publishers/${publisher}/items/${item}`;

  const { json: up } = await call('Chrome upload', `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  });
  let state = up.uploadState ?? '';
  console.log(`Chrome Web Store: uploaded ${up.crxVersion ?? ''} (${state})`);
  for (let i = 0; /IN_PROGRESS/.test(state); i++) {
    if (i >= 60) throw new Error('Chrome upload still in progress after 5 minutes');
    await sleep(5000);
    const { json: st } = await call('Chrome status', `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`, { headers: auth });
    state = st.lastAsyncUploadState ?? '';
  }
  if (!/SUCCEEDED/.test(state)) throw new Error(`Chrome upload failed: ${JSON.stringify(up)} / ${state}`);

  // published with the item's existing visibility (unlisted); a new version is reviewed first
  const { json: pub } = await call('Chrome publish', `https://chromewebstore.googleapis.com/v2/${name}:publish`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
  console.log(`Chrome Web Store: submitted, state ${pub.state}`);
  if (pub.warningInfo) console.log('Chrome Web Store warnings:', JSON.stringify(pub.warningInfo));
}

// ---------------------------------------------------------------- Edge Add-ons

async function edge() {
  const [client, key, product, notes] = [env('EDGE_CLIENT_ID'), env('EDGE_API_KEY'), env('EDGE_PRODUCT_ID'), env('EDGE_CERTIFICATION_NOTES')];
  if (!client || !key || !product) return console.log('Edge Add-ons: credentials not set, skipped');
  if (!notes) throw new Error('Edge Add-ons: EDGE_CERTIFICATION_NOTES is required with every submission');
  const auth = { Authorization: `ApiKey ${key}`, 'X-ClientID': client };
  const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${product}/submissions`;
  // 202 Accepted; the Location header carries the operation ID (or a URL ending in it)
  const operation = (res) => (res.headers.get('location') ?? '').trim().split('/').pop();

  const wait = async (what, url) => {
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const { json } = await call(`${what} status`, url, { headers: auth });
      if (json.status === 'Succeeded') return json;
      if (json.status !== 'InProgress') throw new Error(`${what} failed: ${JSON.stringify(json)}`);
    }
    throw new Error(`${what} still in progress after 5 minutes`);
  };

  const { res: up } = await call('Edge upload', `${base}/draft/package`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/zip' }, body: zip });
  await wait('Edge upload', `${base}/draft/package/operations/${operation(up)}`);
  console.log('Edge Add-ons: package uploaded');

  const { res: pub } = await call('Edge publish', base, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
  await wait('Edge publish', `${base}/operations/${operation(pub)}`);
  console.log('Edge Add-ons: submitted for review');
}

// both stores are tried; any failure fails the step
const results = await Promise.allSettled([chrome(), edge()]);
const failed = results.filter((r) => r.status === 'rejected');
for (const f of failed) console.error(String(f.reason?.stack ?? f.reason));
if (failed.length) process.exit(1);
