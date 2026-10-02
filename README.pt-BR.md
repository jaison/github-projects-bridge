# GitHub Projects Bridge

Servidor remoto do [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para gerenciar GitHub Projects V2 pela API GraphQL do GitHub. Utiliza MCP Streamable HTTP e OAuth 2.1 com Authorization Code + PKCE.

**Documentação:** [English](README.md)

## Ferramentas e permissões

Todas as ferramentas de Projects V2 são expostas com os escopos OAuth do MCP `projects:read` e `projects:write`. O login do GitHub por trás desse consentimento solicita `read:user`, `project`, `repo`, `read:org` e `offline_access`, permitindo que o bridge execute operações de projetos, repositórios/Issues/PRs e times em nome do usuário GitHub autenticado.

### Projetos

`list_projects`, `create_project`, `create_project_advanced`, `get_project`, `get_project_details`, `update_project`, `update_project_settings`, `delete_project`, `copy_project`, `mark_project_as_template`, `unmark_project_as_template`.

### Campos

`list_project_fields`, `get_project_field`, `create_project_field`, `create_project_issue_field`, `update_project_field`, `add_project_field_option`, `update_project_field_option`, `delete_project_field_option`, `delete_project_field`.

O bridge suporta campos customizados do Project V2 dos tipos DATE, ITERATION, MULTI_SELECT, NUMBER, SINGLE_SELECT e TEXT. Os helpers de opções leem a configuração existente e preservam os IDs das opções existentes ao alterar a lista.

### Itens

`list_project_items`, `list_project_items_advanced`, `add_project_item_by_id`, `create_project_draft`, `update_project_draft_issue`, `convert_project_draft_to_issue`, `update_project_single_select`, `update_project_item_field_value`, `clear_project_item_field`, `update_project_item_position`, `archive_project_item`, `unarchive_project_item`, `delete_project_item`.

A listagem avançada suporta paginação, filtro por busca, estado arquivado e ordenação por posição.

### Views

`list_project_views`, `get_project_view`, `create_project_view`, `update_project_view`, `delete_project_view`.

As views suportam layouts board, table e roadmap, filtros e configuração ordenada dos campos visíveis.

### Status updates

`list_project_status_updates`, `get_project_status_update`, `create_project_status_update`, `update_project_status_update`, `delete_project_status_update`.

### Repositórios e times

`list_project_repositories`, `link_project_repository`, `unlink_project_repository`, `list_project_teams`, `link_project_team`, `unlink_project_team`.

### Colaboradores e workflows

`update_project_collaborators` administra colaboradores do projeto e suas funções. Workflows podem ser consultados com `list_project_workflows` e `get_project_workflow`, e removidos com `delete_project_workflow`.

O schema GraphQL atual do GitHub expõe exclusão de workflows, mas não mutations de criação ou atualização de workflows.

## Requisitos

- Node.js 22 ou Docker.
- Uma GitHub OAuth App com autorização para solicitar `read:user`, `project`, `repo`, `read:org` e `offline_access`.
- `GITHUB_TOKEN` é opcional e permanece apenas como fallback temporário para conexões antigas.
- URL pública HTTPS e armazenamento persistente para os dados OAuth.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GITHUB_TOKEN` | Não | Fallback legado de token de serviço. Novas conexões OAuth usam o token do usuário GitHub autenticado. |
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
3. No campo **Homepage URL**, informe o valor de `PUBLIC_URL` (por exemplo, `https://sua.url.com`). Não coloque o caminho `/oauth/github/callback` nesse campo.
4. Na seção **Redirect URIs**, adicione exatamente `PUBLIC_URL/oauth/github/callback` (por exemplo, `https://sua.url.com/oauth/github/callback`). Esse é o endereço do endpoint do bridge que recebe o retorno do GitHub.
5. Crie a aplicação, copie o Client ID e gere um Client Secret.
6. Preencha `GITHUB_OAUTH_CLIENT_ID` e `GITHUB_OAUTH_CLIENT_SECRET`.
7. Em `OAUTH_ALLOWED_GITHUB_USERS`, informe somente os logins que podem utilizar o bridge.

**Não adicione o redirect URI do ChatGPT nessa seção do GitHub.** O ChatGPT é o cliente OAuth do servidor MCP: ele informa seu próprio `redirect_uri` ao endpoint de Dynamic Client Registration (`/oauth/register`), e o bridge valida e armazena esse endereço para a sessão. O redirect URI cadastrado na GitHub OAuth App é exclusivamente `PUBLIC_URL/oauth/github/callback`.

O fluxo de autorização do GitHub solicita `read:user project repo read:org offline_access`. `project` habilita leitura/escrita de Projects do usuário e da organização; `repo` habilita operações de repositório, Issues e pull requests e também cobre recursos de projetos de organizações; `read:org` habilita leituras de organização/times; `offline_access` solicita token expirável com suporte a refresh token. Os escopos OAuth limitam o que o token pode fazer, mas não concedem ao aplicativo permissões que o usuário não possui.

## Gerar o segredo de assinatura

Gere um segredo forte com:

```bash
openssl rand -hex 32
```

Use o resultado em `OAUTH_SIGNING_SECRET`. Não reutilize o PAT do GitHub nem o Client Secret OAuth.

## Credencial OAuth do GitHub

O bridge agora usa o access token OAuth do GitHub pertencente ao usuário autenticado para as chamadas GraphQL e REST. A credencial GitHub é criptografada antes de ser armazenada em `/data`, e os access tokens do MCP contêm apenas uma referência para essa credencial criptografada.

Cada usuário autorizado, portanto, opera com suas próprias permissões do GitHub. Um `GITHUB_TOKEN` legado pode permanecer configurado durante a migração; ele é usado apenas quando uma sessão MCP antiga ainda não possui uma credencial OAuth do GitHub.

O escopo mais amplo solicitado é `repo`, pois GitHub OAuth Apps não oferecem as permissões granulares de repositório disponíveis nos GitHub Apps. O GitHub documenta que `repo` concede acesso total aos repositórios e também permite administrar projetos pertencentes a organizações e associações de times. Para times, o bridge solicita adicionalmente `read:org` porque os campos de team do GraphQL do GitHub exigem esse escopo.

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

Cadastre no ChatGPT o endereço `https://SEU-DOMINIO/mcp` e selecione OAuth como mecanismo de autenticação. O ChatGPT fornece seu redirect URI durante o registro dinâmico; não é necessário cadastrá-lo manualmente na GitHub OAuth App. O servidor anuncia os escopos `projects:read` e `projects:write`. Depois de atualizar a versão anterior, desconecte/reconecte o GPB para que o GitHub apresente e conceda os novos escopos.

## Segurança e limitações

- Use HTTPS e mantenha o serviço atrás do proxy reverso.
- Restrinja `OAUTH_ALLOWED_GITHUB_USERS` aos usuários que realmente devem acessar os projetos.
- Proteja o volume `/data` e as variáveis de ambiente.
- Access tokens expiram em 15 minutos; refresh tokens são rotacionados e expiram em 30 dias.
- O armazenamento JSON foi projetado para uma única instância. Para alta disponibilidade ou múltiplas réplicas, migre o estado para um banco de dados compartilhado.
- As permissões OAuth do GitHub são solicitadas ao usuário durante a autorização. O bridge não pode elevar um usuário além das permissões que ele já possui na conta, repositório ou organização do GitHub.

## Licença

Este repositório ainda não especifica uma licença.
