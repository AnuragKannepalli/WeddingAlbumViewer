const fs = require('fs-extra');
const path = require('path');
const msal = require('@azure/msal-node');
const { DATA_DIR } = require('./store');

const CACHE_FILE = path.join(DATA_DIR, 'onedrive-cache.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Files.Read', 'Files.Read.All', 'offline_access', 'User.Read'];

function redirectUri(port) {
  return `http://localhost:${port}/auth/onedrive/callback`;
}

// Persists MSAL's token cache (including refresh tokens) to disk, so signing
// in once survives restarting the server -- same idea as data/state.json,
// just MSAL's own serialized format rather than ours.
function cachePlugin() {
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (await fs.pathExists(CACHE_FILE)) {
        cacheContext.tokenCache.deserialize(await fs.readFile(CACHE_FILE, 'utf-8'));
      }
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        await fs.writeFile(CACHE_FILE, cacheContext.tokenCache.serialize(), 'utf-8');
      }
    }
  };
}

// One MSAL client per configured Client ID (there's only ever one in
// practice -- this app is single-user -- but re-creating it if the id
// changes avoids a stale client hanging around after the user edits it).
let client = null;
let clientForId = null;
let pendingPkce = null; // { verifier, clientId } for the in-progress sign-in

function getClient(clientId) {
  if (!client || clientForId !== clientId) {
    client = new msal.PublicClientApplication({
      auth: { clientId, authority: 'https://login.microsoftonline.com/common' },
      cache: { cachePlugin: cachePlugin() }
    });
    clientForId = clientId;
  }
  return client;
}

async function getAuthUrl(clientId, port) {
  const c = getClient(clientId);
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  pendingPkce = { verifier, clientId };
  return c.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(port),
    codeChallenge: challenge,
    codeChallengeMethod: 'S256'
  });
}

async function handleCallback(code, port) {
  if (!pendingPkce) throw new Error('No OneDrive sign-in was in progress. Try connecting again.');
  const c = getClient(pendingPkce.clientId);
  const verifier = pendingPkce.verifier;
  pendingPkce = null;
  return c.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: redirectUri(port),
    codeVerifier: verifier
  });
}

async function getAccount(clientId) {
  if (!clientId) return null;
  const accounts = await getClient(clientId).getTokenCache().getAllAccounts();
  return accounts[0] || null;
}

async function getAccessToken(clientId) {
  const account = await getAccount(clientId);
  if (!account) throw new Error('Not signed in to OneDrive yet. Connect it on the Setup tab first.');
  const result = await getClient(clientId).acquireTokenSilent({ scopes: SCOPES, account });
  return result.accessToken;
}

async function signOut(clientId) {
  const account = await getAccount(clientId);
  if (account) await getClient(clientId).getTokenCache().removeAccount(account);
}

async function graphFetch(accessToken, urlPath, opts = {}) {
  return fetch(`${GRAPH_BASE}${urlPath}`, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) }
  });
}

module.exports = { getAuthUrl, handleCallback, getAccount, getAccessToken, signOut, graphFetch };
