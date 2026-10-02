# GitHub Projects Bridge

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing GitHub Projects V2 through the GitHub GraphQL API. It uses MCP Streamable HTTP and OAuth 2.1 Authorization Code with PKCE.

**Documentation:** [Português (Brasil)](README.pt-BR.md)

## Tools and scopes

| Tools | Scope |
| --- | --- |
| `list_projects`, `get_project`, `list_project_items` | `projects:read` |
| `create_project_draft`, `update_project`, `update_project_single_select`, `delete_project_item` | `projects:write` |

## Requirements

- Node.js 22 or Docker.
- A GitHub Personal Access Token (classic) with the `project` scope for personal-account Projects V2.
- A GitHub OAuth App.
- A public HTTPS URL and persistent storage for OAuth state.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Classic PAT with `project` (**Full control of projects**), used by the server for GraphQL calls. |
| `GITHUB_OWNER` | Yes | GitHub login of the user or organization that owns the projects. |
| `PUBLIC_URL` | Yes | Canonical public HTTPS URL of this MCP server, without trailing slash. |
| `GITHUB_OAUTH_CLIENT_ID` | Yes | GitHub OAuth App client ID. |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GitHub OAuth App client secret. |
| `OAUTH_ALLOWED_GITHUB_USERS` | Yes | Comma-separated GitHub logins allowed to use the bridge. |
| `OAUTH_SIGNING_SECRET` | Yes | Random secret of at least 32 characters used to sign access tokens. |
| `OAUTH_DATA_FILE` | No | Persistent OAuth state file. Defaults to `/data/oauth-state.json`. |
| `PORT` | No | Internal HTTP port. Defaults to `80`. |

## Create the GitHub OAuth App

1. Open [GitHub Developer Settings](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**.
2. Enter an application name.
3. Set **Homepage URL** to the value of `PUBLIC_URL` (for example, `https://your.url.com`). Do not include the `/oauth/github/callback` path in this field.
4. Under **Redirect URIs**, add exactly `PUBLIC_URL/oauth/github/callback` (for example, `https://your.url.com/oauth/github/callback`). This is the bridge endpoint that receives the response from GitHub.
5. Create the app, copy its Client ID, and generate a Client Secret.
6. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
7. Set `OAUTH_ALLOWED_GITHUB_USERS` to only the GitHub logins allowed to use the bridge.

**Do not add ChatGPT's redirect URI to this GitHub section.** ChatGPT is the OAuth client for the MCP server: it supplies its own `redirect_uri` to the Dynamic Client Registration endpoint (`/oauth/register`), and the bridge validates and stores that URI for the session. The redirect URI configured in the GitHub OAuth App is exclusively `PUBLIC_URL/oauth/github/callback`.

The login flow requests only GitHub's `read:user` scope. OAuth login and the service token used for Projects V2 are separate credentials.

## Generate the signing secret

Generate a strong secret:

```bash
openssl rand -hex 32
```

Set the result as `OAUTH_SIGNING_SECRET`. Do not reuse the GitHub PAT or OAuth Client Secret.

## GitHub service token

For Projects V2 owned by a personal GitHub account, create a classic Personal Access Token with the `project` scope — **Full control of projects**. Do not add `repo` solely for project-board operations.

`GITHUB_TOKEN` stays on the server. ChatGPT receives an OAuth access token issued by this bridge, never the PAT. All authorized users operate with the permissions of this service token.

## Persistence

OAuth state includes registered clients, authorization codes, and hashed refresh tokens. It must survive restarts and redeployments.

On Easypanel, mount a persistent volume at `/data`. This implementation assumes a single service instance; do not run multiple independent replicas sharing the JSON file.

## Easypanel deployment

1. Create an **App** service connected to this repository.
2. Select **Dockerfile** as the build method.
3. Configure the environment variables above.
4. Set internal port `80`, domain, and HTTPS.
5. Mount a persistent volume at `/data`.
6. Verify the GitHub OAuth App settings: **Homepage URL** = `PUBLIC_URL`; **Redirect URI** = `PUBLIC_URL/oauth/github/callback`.
7. Deploy.

## Endpoints

- `GET /health` — public health check.
- `POST /mcp` — OAuth-protected MCP Streamable HTTP endpoint.
- `GET /.well-known/oauth-protected-resource` — resource-server metadata.
- `GET /.well-known/oauth-authorization-server` — authorization-server metadata.
- `POST /oauth/register` — Dynamic Client Registration.
- `GET /oauth/authorize` — Authorization Code + PKCE entry point.
- `POST /oauth/token` — authorization-code exchange and token refresh.
- `GET /oauth/github/callback` — GitHub authentication callback.

Register `https://YOUR-DOMAIN/mcp` in ChatGPT and select OAuth as the authentication method. ChatGPT supplies its redirect URI during dynamic registration; you do not need to add it manually to the GitHub OAuth App. The server advertises the `projects:read` and `projects:write` scopes.

## Security and limitations

- Use HTTPS and keep the service behind a reverse proxy.
- Restrict `OAUTH_ALLOWED_GITHUB_USERS` to users who should access these projects.
- Protect the `/data` volume and environment variables.
- Access tokens expire after 15 minutes; refresh tokens rotate and expire after 30 days.
- JSON-file state is designed for a single instance. For high availability or multiple replicas, migrate state to a shared database.
- OAuth enables authentication, but availability of write tools also depends on ChatGPT plan permissions.

## License

No license has been specified for this repository yet.
