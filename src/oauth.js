import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCOPES = ["projects:read", "projects:write", "offline_access"];
const now = () => Math.floor(Date.now() / 1000);
const b64url = value => Buffer.from(value).toString("base64url");
const hash = value => createHmac("sha256", "github-projects-bridge-oauth-store").update(value).digest("hex");
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function html(res, status, value) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(value);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32768) throw new Error("Request body too large");
  }
  return body;
}

async function readForm(req) {
  return new URLSearchParams(await readBody(req));
}

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const input = header + "." + body;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  return input + "." + signature;
}

function verifyJwt(token, secret, issuer, audience) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const input = parts[0] + "." + parts[1];
    const expected = createHmac("sha256", secret).update(input).digest("base64url");
    if (!safeEqual(parts[2], expected)) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (header.alg !== "HS256" || payload.iss !== issuer || payload.aud !== audience || payload.exp <= now() || payload.nbf > now()) return null;
    if (typeof payload.sub !== "string" || !Array.isArray(payload.scopes)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createOAuth() {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
  const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const signingSecret = process.env.OAUTH_SIGNING_SECRET;
  const allowedUsers = new Set((process.env.OAUTH_ALLOWED_GITHUB_USERS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
  const dataFile = resolve(process.env.OAUTH_DATA_FILE || "/data/oauth-state.json");

  if (!publicUrl || !publicUrl.startsWith("https://")) throw new Error("PUBLIC_URL must be the canonical HTTPS URL of this MCP server, without a trailing slash.");
  if (!githubClientId || !githubClientSecret) throw new Error("Configure GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.");
  if (!signingSecret || signingSecret.length < 32) throw new Error("OAUTH_SIGNING_SECRET must contain at least 32 characters.");
  if (!allowedUsers.size) throw new Error("OAUTH_ALLOWED_GITHUB_USERS must contain at least one allowed GitHub username.");

  const githubCallback = publicUrl + "/oauth/github/callback";
  const state = {
    clients: {},
    requests: {},
    consents: {},
    codes: {},
    refreshTokens: {}
  };

  let writeQueue = Promise.resolve();
  const persist = () => {
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      const temp = dataFile + ".tmp";
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, dataFile);
    });
    return writeQueue;
  };

  const ready = (async () => {
    try {
      const saved = JSON.parse(await readFile(dataFile, "utf8"));
      for (const key of Object.keys(state)) Object.assign(state[key], saved[key] || {});
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await persist();
    }
  })();

  const metadata = {
    issuer: publicUrl,
    authorization_endpoint: publicUrl + "/oauth/authorize",
    token_endpoint: publicUrl + "/oauth/token",
    registration_endpoint: publicUrl + "/oauth/register",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true
  };

  function protectedResourceMetadata() {
    return {
      resource: publicUrl,
      authorization_servers: [publicUrl],
      scopes_supported: SCOPES,
      resource_documentation: "https://github.com/jaison/github-projects-bridge"
    };
  }

  function issueAccessToken(username, clientId, scopes) {
    const issued = now();
    return signJwt({
      iss: publicUrl,
      sub: username,
      aud: publicUrl,
      client_id: clientId,
      scope: scopes,
      iat: issued,
      nbf: issued,
      exp: issued + 900,
      jti: randomUUID()
    }, signingSecret);
  }

  function issueRefreshToken(username, clientId, scopes) {
    const token = random(48);
    state.refreshTokens[hash(token)] = {
      username, clientId, scopes, expiresAt: now() + 60 * 60 * 24 * 30
    };
    return token;
  }

  function validClient(clientId, redirectUri) {
    const client = state.clients[clientId];
    return client && client.redirect_uris.includes(redirectUri) ? client : null;
  }

  async function handle(req, res, url) {
    await ready;
    const path = url.pathname;

    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      json(res, 200, protectedResourceMetadata());
      return true;
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(res, 200, metadata);
      return true;
    }

    if (req.method === "POST" && path === "/oauth/register") {
      let input;
      try { input = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid_client_metadata" }); return true; }
      const redirects = input.redirect_uris;
      const validRedirect = uri => {
        if (typeof uri !== "string") return false;
        try {
          const parsed = new URL(uri);
          return (parsed.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname)) ||
            (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
        } catch {
          return false;
        }
      };
      if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || redirects.some(uri => !validRedirect(uri))) {
        json(res, 400, { error: "invalid_redirect_uri" });
        return true;
      }
      const clientId = randomUUID();
      const client = {
        client_id: clientId,
        client_name: String(input.client_name || "MCP client").slice(0, 120),
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      };
      state.clients[clientId] = client;
      await persist();
      json(res, 201, { ...client, client_id_issued_at: now() });
      return true;
    }

    if (req.method === "GET" && path === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const responseType = url.searchParams.get("response_type");
      const challenge = url.searchParams.get("code_challenge");
      const challengeMethod = url.searchParams.get("code_challenge_method");
      const resource = url.searchParams.get("resource");
      const scopes = (url.searchParams.get("scope") || "projects:read").split(/\s+/).filter(Boolean);
      const client = validClient(clientId, redirectUri);
      if (!client || responseType !== "code" || !challenge || challengeMethod !== "S256" || resource !== publicUrl || scopes.some(s => !SCOPES.includes(s))) {
        json(res, 400, { error: "invalid_request", error_description: "Invalid client, redirect URI, resource, scope, or PKCE parameters." });
        return true;
      }
      const githubState = random();
      state.requests[githubState] = {
        clientId, redirectUri, challenge, resource, scopes,
        state: url.searchParams.get("state") || "",
        createdAt: now()
      };
      await persist();
      const githubUrl = new URL("https://github.com/login/oauth/authorize");
      githubUrl.searchParams.set("client_id", githubClientId);
      githubUrl.searchParams.set("redirect_uri", githubCallback);
      githubUrl.searchParams.set("scope", "read:user");
      githubUrl.searchParams.set("state", githubState);
      res.writeHead(302, { location: githubUrl.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (req.method === "GET" && path === "/oauth/github/callback") {
      const githubState = url.searchParams.get("state") || "";
      const request = state.requests[githubState];
      delete state.requests[githubState];
      if (!request || request.createdAt < now() - 600) {
        await persist();
        html(res, 400, "<h1>Autorização expirada. Feche esta janela e tente novamente.</h1>");
        return true;
      }
      if (url.searchParams.has("error")) {
        const denied = new URL(request.redirectUri);
        denied.searchParams.set("error", "access_denied");
        if (request.state) denied.searchParams.set("state", request.state);
        denied.searchParams.set("iss", publicUrl);
        await persist();
        res.writeHead(302, { location: denied.toString(), "cache-control": "no-store" });
        res.end();
        return true;
      }
      try {
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: githubClientId, client_secret: githubClientSecret, code: url.searchParams.get("code"), redirect_uri: githubCallback })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || !tokenData.access_token) throw new Error("GitHub OAuth exchange failed");
        const userResponse = await fetch("https://api.github.com/user", {
          headers: { authorization: "Bearer " + tokenData.access_token, accept: "application/vnd.github+json", "user-agent": "github-projects-bridge" }
        });
        const user = await userResponse.json();
        if (!userResponse.ok || !user.login || !allowedUsers.has(user.login.toLowerCase())) {
          const denied = new URL(request.redirectUri);
          denied.searchParams.set("error", "access_denied");
          if (request.state) denied.searchParams.set("state", request.state);
          denied.searchParams.set("iss", publicUrl);
          await persist();
          res.writeHead(302, { location: denied.toString(), "cache-control": "no-store" });
          res.end();
          return true;
        }
        const consentId = random();
        state.consents[consentId] = { ...request, username: user.login, createdAt: now() };
        await persist();
        const scopeText = request.scopes.join(", ");
        html(res, 200, `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autorizar GitHub Projects Bridge</title><body style="font:16px system-ui;max-width:560px;margin:10vh auto;padding:24px;color:#222"><h1>Autorizar acesso</h1><p>Conta GitHub: <strong>${escapeHtml(user.login)}</strong></p><p>Aplicativo: <strong>${escapeHtml(request.clientName)}</strong></p><p>O aplicativo solicita as permissões: <strong>${escapeHtml(scopeText)}</strong>.</p><form method="post" action="/oauth/consent"><input type="hidden" name="consent_id" value="${consentId}"><button name="decision" value="approve">Autorizar</button> <button name="decision" value="deny">Negar</button></form></body></html>`);
      } catch {
        html(res, 502, "<h1>Não foi possível autenticar com o GitHub. Tente novamente.</h1>");
      }
      return true;
    }

    if (req.method === "POST" && path === "/oauth/consent") {
      let form;
      try { form = await readForm(req); } catch { json(res, 400, { error: "invalid_request" }); return true; }
      const consentId = form.get("consent_id") || "";
      const consent = state.consents[consentId];
      delete state.consents[consentId];
      if (!consent || consent.createdAt < now() - 600) {
        html(res, 400, "<h1>Solicitação expirada. Feche esta janela e tente novamente.</h1>");
        return true;
      }
      if (form.get("decision") !== "approve") {
        const denied = new URL(consent.redirectUri);
        denied.searchParams.set("error", "access_denied");
        if (consent.state) denied.searchParams.set("state", consent.state);
        if (consent.clientId) denied.searchParams.set("iss", publicUrl);
        await persist();
        res.writeHead(302, { location: denied.toString(), "cache-control": "no-store" });
        res.end();
        return true;
      }
      const code = random(32);
      state.codes[hash(code)] = {
        ...consent,
        expiresAt: now() + 120
      };
      await persist();
      const callback = new URL(consent.redirectUri);
      callback.searchParams.set("code", code);
      if (consent.state) callback.searchParams.set("state", consent.state);
      callback.searchParams.set("iss", publicUrl);
      res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (req.method === "POST" && path === "/oauth/token") {
      let form;
      try { form = await readForm(req); } catch { json(res, 400, { error: "invalid_request" }); return true; }
      const grantType = form.get("grant_type");
      const clientId = form.get("client_id") || "";
      const resource = form.get("resource");
      if (resource !== publicUrl) {
        json(res, 400, { error: "invalid_target", error_description: "The resource parameter must match this MCP server." });
        return true;
      }
      if (grantType === "authorization_code") {
        const code = form.get("code") || "";
        const key = hash(code);
        const record = state.codes[key];
        delete state.codes[key];
        const verifier = form.get("code_verifier") || "";
        const challenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : "";
        if (!record || record.expiresAt < now() || record.clientId !== clientId || record.redirectUri !== form.get("redirect_uri") || !safeEqual(challenge, record.challenge)) {
          await persist();
          json(res, 400, { error: "invalid_grant" });
          return true;
        }
        const accessToken = issueAccessToken(record.username, clientId, record.scopes);
        const refreshToken = issueRefreshToken(record.username, clientId, record.scopes);
        await persist();
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 900, refresh_token: refreshToken, scope: record.scopes.join(" ") });
        return true;
      }
      if (grantType === "refresh_token") {
        const oldToken = form.get("refresh_token") || "";
        const key = hash(oldToken);
        const record = state.refreshTokens[key];
        if (!record || record.expiresAt < now() || record.clientId !== clientId) {
          json(res, 400, { error: "invalid_grant" });
          return true;
        }
        delete state.refreshTokens[key];
        const accessToken = issueAccessToken(record.username, clientId, record.scopes);
        const refreshToken = issueRefreshToken(record.username, clientId, record.scopes);
        await persist();
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 900, refresh_token: refreshToken, scope: record.scopes.join(" ") });
        return true;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return true;
    }
    return false;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  return {
    handle,
    publicUrl,
    verifyAccessToken(token) {
      return verifyJwt(token, signingSecret, publicUrl, publicUrl);
    },
    requiredScopes: SCOPES
  };
}
