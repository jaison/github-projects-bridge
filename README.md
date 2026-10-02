# GitHub Projects Bridge

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing GitHub Projects V2 through the GitHub GraphQL API. It uses MCP Streamable HTTP and OAuth 2.1 Authorization Code with PKCE.

**Documentation:** [Português (Brasil)](README.pt-BR.md)

## Tools and scopes

All Project V2 tools are exposed under the MCP OAuth scopes `projects:read` and `projects:write`. The GitHub login behind that consent requests the GitHub scopes `read:user`, `project`, `repo`, `read:org` and `offline_access`, so the bridge can perform project, repository/issue/PR and team operations on behalf of the authenticated GitHub user.

### Projects

`list_projects`, `create_project`, `create_project_advanced`, `get_project`, `get_project_details`, `update_project`, `update_project_settings`, `delete_project`, `copy_project`, `mark_project_as_template`, `unmark_project_as_template`.

### Fields

`list_project_fields`, `get_project_field`, `create_project_field`, `create_project_issue_field`, `update_project_field`, `add_project_field_option`, `update_project_field_option`, `delete_project_field_option`, `delete_project_field`.

The bridge supports Project V2 custom fields of type DATE, ITERATION, MULTI_SELECT, NUMBER, SINGLE_SELECT and TEXT. Select-field option helpers read the existing configuration and preserve existing option IDs when changing the list.

### Items

`list_project_items`, `list_project_items_advanced`, `add_project_item_by_id`, `create_project_draft`, `update_project_draft_issue`, `convert_project_draft_to_issue`, `update_project_single_select`, `update_project_item_field_value`, `clear_project_item_field`, `update_project_item_position`, `archive_project_item`, `unarchive_project_item`, `delete_project_item`.

Advanced item listing supports pagination, query filtering, archived-state filtering and position ordering.

### Views

`list_project_views`, `get_project_view`, `create_project_view`, `update_project_view`, `delete_project_view`.

Views support board, table and roadmap layouts, filters and ordered visible-field configuration.

### Status updates

`list_project_status_updates`, `get_project_status_update`, `create_project_status_update`, `update_project_status_update`, `delete_project_status_update`.

### Repositories and teams

`list_project_repositories`, `link_project_repository`, `unlink_project_repository`, `list_project_teams`, `link_project_team`, `unlink_project_team`.

### Collaborators and workflows

`update_project_collaborators` manages project collaborators and their roles. Workflows can be inspected with `list_project_workflows` and `get_project_workflow`, and removed with `delete_project_workflow`.

The current GitHub GraphQL Projects schema exposes workflow deletion, but no workflow creation or update mutation.

## Requirements

- Node.js 22 or Docker.
- A GitHub OAuth App with permission to request `read:user`, `project`, `repo`, `read:org` and `offline_access`.
- No server-side GitHub Personal Access Token is required; the bridge uses the authenticated GitHub user OAuth token.
- A public HTTPS URL and persistent storage for OAuth state.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |

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

The GitHub authorization flow requests `read:user project repo read:org offline_access`. `project` enables read/write access to user and organization Projects; `repo` enables repository, issue and pull-request operations and also covers organization-owned project resources; `read:org` enables organization/team reads; `offline_access` requests an expiring access token plus refresh-token support. GitHub OAuth scopes limit what the token can do but do not grant permissions the user does not already have.

## Generate the signing secret

Generate a strong secret:

```bash
openssl rand -hex 32
```

Set the result as `OAUTH_SIGNING_SECRET`. Do not reuse the GitHub PAT or OAuth Client Secret.

## GitHub OAuth credential

The bridge now uses the GitHub OAuth access token belonging to the authenticated user for GraphQL and REST calls. The GitHub credential is encrypted before being stored in `/data`, and MCP access tokens contain only a reference to that encrypted credential.

Each authorized user acts only with their own GitHub permissions. There is no server-side PAT fallback: after this upgrade, users with an older connection must authorize the bridge again.

The broadest requested scope is `repo`, because GitHub OAuth Apps do not expose the granular repository permissions available to GitHub Apps. GitHub documents that `repo` grants full access to repositories and also enables management of organization-owned projects and team memberships. For teams, this bridge additionally requests `read:org` because the GitHub GraphQL team fields require it.

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

Register `https://YOUR-DOMAIN/mcp` in ChatGPT and select OAuth as the authentication method. ChatGPT supplies its redirect URI during dynamic registration; you do not need to add it manually to the GitHub OAuth App. The server advertises the `projects:read` and `projects:write` scopes. After upgrading from an older bridge version, disconnect/reconnect the GPB connection so GitHub can show and grant the newly requested scopes.

## Security and limitations

- Use HTTPS and keep the service behind a reverse proxy.
- Restrict `OAUTH_ALLOWED_GITHUB_USERS` to users who should access these projects.
- Protect the `/data` volume and environment variables.
- Access tokens expire after 15 minutes; refresh tokens rotate and expire after 30 days.
- JSON-file state is designed for a single instance. For high availability or multiple replicas, migrate state to a shared database.
- GitHub OAuth permissions are requested from the user during GitHub authorization. The bridge cannot elevate a user beyond their GitHub account, repository or organization permissions.

## License

No license has been specified for this repository yet.
