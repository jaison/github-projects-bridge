# GitHub Projects Bridge

Servidor remoto do [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para gerenciar GitHub Projects V2 pela API GraphQL do GitHub. Utiliza MCP Streamable HTTP e OAuth 2.1 com Authorization Code + PKCE.

**Documentação:** [English](README.md)

## Ferramentas e permissões

| Ferramenta | Escopo |
| --- | --- |
| `list_projects`, `get_project`, `list_project_items` | `projects:read` |
| `create_project_draft`, `update_project_single_select`, `delete_project_item` | `projects:write` |

## Requisitos

- Node.js 22 ou Docker.
- GitHub Personal Access Token (classic) com escopo `project` para Projects V2 de conta pessoal.
- Uma GitHub OAuth App.
- URL pública HTTPS e armazenamento persistente para os dados OAuth.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GITHUB_TOKEN` | Sim | PAT classic com escopo `project` (**Full control of projects**), usado pelo servidor nas chamadas GraphQL. |
| `GITHUB_OWNER` | Sim | Login do usuário ou organização proprietária dos projetos. |
| `PUBLIC_URL` | Sim | URL HTTPS pública e canônica do MCP, sem barra final. |
| `GITHUB_OAUTH_CLIENT_ID` | Sim | Client ID da GitHub OAuth App. |
| `GITHUB_OAUTH_CLIENT_SECRET` | Sim | Client Secret da GitHub OAuth App. |
| `OAUTH_ALLOWED_GITHUB_USERS` | Sim | Logins GitHub autorizados, separados por vírgula. |
| `OAUTH_SIGNING_SECRET` | Sim | Segredo aleatório com pelo menos 32 caracteres para assinar access tokens. |
| `OAUTH_DATA_FILE` | Não | Arquivo persistente de estado OAuth. Padrão: `/data/oauth-state.json`. |
| `PORT` | Não | Porta HTTP interna. Padrão: `80`. |

## Criar a GitHub OAuth App

1. Acesse [GitHub Developer Settings](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**.
2. No campo **Application name**, informe um nome para o bridge.
3. No campo **Homepage URL**, informe o valor de `PUBLIC_URL` (por exemplo, `https://gpb.dev.perazza.com`). Não coloque o caminho `/oauth/github/callback` nesse campo.
4. Na seção **Redirect URIs**, adicione exatamente `PUBLIC_URL/oauth/github/callback` (por exemplo, `https://gpb.dev.perazza.com/oauth/github/callback`). Esse é o endereço do endpoint do bridge que recebe o retorno do GitHub.
5. Crie a aplicação, copie o Client ID e gere um Client Secret.
6. Preencha `GITHUB_OAUTH_CLIENT_ID` e `GITHUB_OAUTH_CLIENT_SECRET`.
7. Em `OAUTH_ALLOWED_GITHUB_USERS`, informe somente os logins que podem utilizar o bridge.

**Não adicione o redirect URI do ChatGPT nessa seção do GitHub.** O ChatGPT é o cliente OAuth do servidor MCP: ele informa seu próprio `redirect_uri` ao endpoint de Dynamic Client Registration (`/oauth/register`), e o bridge valida e armazena esse endereço para a sessão. O redirect URI cadastrado na GitHub OAuth App é exclusivamente `PUBLIC_URL/oauth/github/callback`.

O login solicita apenas o escopo `read:user` do GitHub. A autenticação OAuth e o token de serviço usado para acessar Projects V2 são credenciais distintas.

## Gerar o segredo de assinatura

Gere um segredo forte com:

```bash
openssl rand -hex 32
```

Use o resultado em `OAUTH_SIGNING_SECRET`. Não reutilize o PAT do GitHub nem o Client Secret OAuth.

## Token de serviço do GitHub

Para Projects V2 pertencentes a uma conta pessoal, crie um Personal Access Token (classic) com o escopo `project` — **Full control of projects**. Não adicione `repo` apenas para administrar quadros de projetos.

O `GITHUB_TOKEN` fica exclusivamente no servidor. O ChatGPT recebe um access token OAuth emitido pelo bridge, nunca o PAT. Todos os usuários autorizados operam com as permissões desse token de serviço.

## Persistência

O estado OAuth contém clientes registrados, códigos de autorização e refresh tokens (armazenados como hashes). Ele precisa sobreviver a reinicializações e redeploys.

No Easypanel, monte um volume persistente em `/data`. Esta implementação pressupõe uma única instância do serviço; não execute múltiplas réplicas independentes compartilhando o arquivo JSON.

## Deploy no Easypanel

1. Crie um serviço **App** conectado a este repositório.
2. Selecione **Dockerfile** como método de build.
3. Configure as variáveis de ambiente descritas acima.
4. Configure a porta interna `80`, domínio e HTTPS.
5. Monte um volume persistente em `/data`.
6. Confira na GitHub OAuth App: **Homepage URL** = `PUBLIC_URL`; **Redirect URI** = `PUBLIC_URL/oauth/github/callback`.
7. Faça o deploy.

## Endpoints

- `GET /health` — health check público.
- `POST /mcp` — endpoint MCP Streamable HTTP protegido por OAuth.
- `GET /.well-known/oauth-protected-resource` — metadados do resource server.
- `GET /.well-known/oauth-authorization-server` — metadados do authorization server.
- `POST /oauth/register` — Dynamic Client Registration.
- `GET /oauth/authorize` — início do Authorization Code + PKCE.
- `POST /oauth/token` — troca de authorization code e renovação de tokens.
- `GET /oauth/github/callback` — callback de autenticação GitHub.

Cadastre no ChatGPT o endereço `https://SEU-DOMINIO/mcp` e selecione OAuth como mecanismo de autenticação. O ChatGPT fornece seu redirect URI durante o registro dinâmico; não é necessário cadastrá-lo manualmente na GitHub OAuth App. O servidor anuncia os escopos `projects:read` e `projects:write`.

## Segurança e limitações

- Use HTTPS e mantenha o serviço atrás do proxy reverso.
- Restrinja `OAUTH_ALLOWED_GITHUB_USERS` aos usuários que realmente devem acessar os projetos.
- Proteja o volume `/data` e as variáveis de ambiente.
- Access tokens expiram em 15 minutos; refresh tokens são rotacionados e expiram em 30 dias.
- O armazenamento JSON foi projetado para uma única instância. Para alta disponibilidade ou múltiplas réplicas, migre o estado para um banco de dados compartilhado.
- OAuth habilita a autenticação, mas a disponibilidade das ferramentas de escrita também depende das permissões do plano ChatGPT.

## Licença

Este repositório ainda não especifica uma licença.
