# GitHub Projects Bridge

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing GitHub Projects V2 through the GitHub GraphQL API. It exposes project discovery and item-management tools over Streamable HTTP and is designed to run as a small container, including on Easypanel.

**Documentation:** [Português (Brasil)](README.pt-BR.md)

## Features

| Tool | Description |
| --- | --- |
| `list_projects` | List Projects V2 owned by a GitHub user or organization. |
| `get_project` | Retrieve a project, including its fields and single-select options. |
| `list_project_items` | List project items, their content, and supported field values. |
| `create_project_draft` | Create a draft issue card in a project. |
| `update_project_single_select` | Set a single-select field value, such as Status or Priority. |
| `delete_project_item` | Remove an item from a project. |

HTTP endpoints:

- `GET /health` — health check.
- `POST /mcp` — authenticated MCP Streamable HTTP endpoint.

## Requirements

- Node.js 22 or Docker.
- A GitHub Personal Access Token (classic) with the `project` scope for Projects V2 boards owned by a personal GitHub account.
- The GitHub user or organization that owns the projects.

## Configuration

Clone the repository and create your environment file:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token (classic) with the `project` scope (**Full control of projects**) for personal-account Projects V2. |
| `MCP_ACCESS_TOKEN` | Yes | Strong, private secret used to authenticate requests to the MCP endpoint. |
| `GITHUB_OWNER` | Yes | GitHub login of the user or organization that owns the projects. |
| `PORT` | No | Internal HTTP port. Defaults to `80`. |

### Create the GitHub token

For Projects V2 boards owned by a personal GitHub account:

1. Open [GitHub token settings — Tokens (classic)](https://github.com/settings/tokens).
2. Select **Generate new token (classic)**.
3. Give it a descriptive name.
4. Under **Select scopes**, enable `project` — **Full control of projects**. GitHub also selects `read:project`; this is expected.
5. Generate the token and copy it. GitHub displays the token only once.

Do not add the `repo` scope for project-board operations alone.

Fine-grained personal access tokens currently cannot access Projects owned by a personal user account. For organization-owned Projects V2, fine-grained tokens support the organization-level **Projects** permission, subject to the organization's token policy and approval requirements.

### Generate the MCP access secret

Generate a separate secret for MCP authentication, for example:

```bash
openssl rand -hex 32
```

Keep the GitHub token and MCP access token separate. The values in `.env.example` are placeholders. Never commit `.env` or expose either token.

## Run locally

```bash
npm install
npm start
```

The server listens on `0.0.0.0:80` by default.

```bash
curl http://localhost:80/health
```

Expected response:

```json
{"ok":true,"service":"github-projects-bridge"}
```

## Run with Docker

```bash
docker build -t github-projects-bridge .
docker run -d \
  --name github-projects-bridge \
  -p 80:80 \
  --env-file .env \
  github-projects-bridge
```

## Deploy on Easypanel

1. Create an **App** service connected to this GitHub repository.
2. Select **Dockerfile** as the build method and use the root `Dockerfile`.
3. Add the environment variables listed above in the Easypanel service settings. Do not commit a `.env` file.
4. Set the internal port to `80` and attach a domain with HTTPS.
5. Deploy and verify `https://YOUR-DOMAIN/health`.

The MCP endpoint is `https://YOUR-DOMAIN/mcp`. Requests must include:

```http
Authorization: Bearer YOUR_MCP_ACCESS_TOKEN
```

The health endpoint is public and does not require the MCP access token.

## Connect an MCP client

Configure an MCP-compatible client to use the HTTPS `/mcp` URL and provide the access token using HTTP Bearer authentication. The client must support MCP Streamable HTTP and custom authorization headers.

## Security

- Expose the service through an HTTPS reverse proxy; do not publish the container port directly to the internet.
- Keep `GITHUB_TOKEN` and `MCP_ACCESS_TOKEN` private and use different values.
- For personal-account Projects V2, use only the classic PAT `project` scope; do not add `repo` unless another feature explicitly requires repository access.
- Store secrets in deployment environment settings, not in source control.
- Rotate both credentials if either may have been exposed.
- Restrict access to the Easypanel project and its environment variables.

## License

No license has been specified for this repository yet.
