# GitHub Projects Bridge

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing GitHub Projects V2 through the GitHub GraphQL API. It exposes project discovery and item-management tools over Streamable HTTP and is designed to run as a small container, including on Easypanel.

**Documentation:** [Português (Brasil)](README.pt-BR.md)

## Features

The server currently exposes these MCP tools:

| Tool | Description |
| --- | --- |
| `list_projects` | List Projects V2 owned by a GitHub user or organization. |
| `get_project` | Retrieve a project, including its fields and single-select options. |
| `list_project_items` | List project items, their content, and supported field values. |
| `create_project_draft` | Create a draft issue card in a project. |
| `update_project_single_select` | Set a single-select field value, such as Status or Priority. |
| `delete_project_item` | Remove an item from a project. |

The HTTP service provides:

- `GET /health` — health check.
- `POST /mcp` — authenticated MCP Streamable HTTP endpoint.

## Requirements

- Node.js 22 or Docker.
- A GitHub fine-grained Personal Access Token (PAT).
- A GitHub user or organization that owns the Projects V2 boards you want to manage.

## Configuration

Clone the repository and create your environment file:

```bash
cp .env.example .env
```

Set the following variables in `.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | GitHub fine-grained PAT with **Projects: Read and write** permission. |
| `MCP_ACCESS_TOKEN` | Yes | A strong, private secret used to authenticate requests to the MCP endpoint. |
| `GITHUB_OWNER` | Yes | GitHub login of the user or organization that owns the projects. |
| `PORT` | No | Internal HTTP port. Defaults to `3000`. |

Generate a dedicated MCP access secret, for example:

```bash
openssl rand -hex 32
```

Keep the GitHub token and MCP access token separate. The values in `.env.example` are placeholders, not working credentials. Never commit `.env` or expose either token.

### GitHub token permissions

Create a fine-grained PAT under **GitHub → Settings → Developer settings → Personal access tokens**. Grant **Projects: Read and write** for the relevant account or organization. Organization-owned projects may require the organization owner's approval of the token.

Use the minimum access scope needed for the projects you intend to manage.

## Run locally

Install dependencies and start the server:

```bash
npm install
npm start
```

The server listens on `0.0.0.0:3000` by default. Check its health endpoint:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"ok":true,"service":"github-projects-bridge"}
```

## Run with Docker

Build and run the container, providing the environment variables from your deployment environment:

```bash
docker build -t github-projects-bridge .
docker run -d \
  --name github-projects-bridge \
  -p 3000:3000 \
  --env-file .env \
  github-projects-bridge
```

## Deploy on Easypanel

1. Create an **App** service connected to this GitHub repository.
2. Choose **Dockerfile** as the build method and use the repository's root `Dockerfile`.
3. Add the environment variables listed in the [Configuration](#configuration) section in the Easypanel service settings. Use real values; do not add a `.env` file to the repository.
4. Set the internal service port to `3000` and attach a domain with HTTPS.
5. Deploy the service.
6. Verify that `https://YOUR-DOMAIN/health` returns the expected health-check response.

The MCP endpoint will be:

```text
https://YOUR-DOMAIN/mcp
```

Requests to `/mcp` must include this HTTP header:

```http
Authorization: Bearer YOUR_MCP_ACCESS_TOKEN
```

The health endpoint is public and does not require the MCP access token.

## Connect an MCP client

Configure your MCP-compatible client to use the server's HTTPS `/mcp` URL and provide the access token using HTTP Bearer authentication. The client must support the MCP Streamable HTTP transport and custom authorization headers.

Client setup varies by product and version. The GitHub connector built into a client does not automatically connect to this server; add this endpoint as a separate MCP server/connector where custom MCP connections are supported.

## Security

- Expose the service through an HTTPS reverse proxy; do not publish the container port directly to the internet.
- Keep `GITHUB_TOKEN` and `MCP_ACCESS_TOKEN` private and use different values for them.
- Limit the GitHub token to the required Projects permission and account scope.
- Store secrets in the deployment platform's environment settings, not in source control.
- Rotate both credentials if either one may have been exposed.
- Restrict access to the Easypanel project and its environment variables.

## License

No license has been specified for this repository yet.