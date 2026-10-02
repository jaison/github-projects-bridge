# GitHub Projects Bridge

Servidor remoto do [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para gerenciar GitHub Projects V2 por meio da API GraphQL do GitHub. Disponibiliza ferramentas para localizar projetos e gerenciar seus cards via Streamable HTTP, podendo ser executado em um contêiner leve ou no Easypanel.

**Documentação:** [English](README.md)

## Recursos

| Ferramenta | Descrição |
| --- | --- |
| `list_projects` | Lista os Projects V2 pertencentes a um usuário ou organização do GitHub. |
| `get_project` | Consulta um projeto, incluindo seus campos e opções de seleção única. |
| `list_project_items` | Lista os itens do projeto, seus conteúdos e os valores dos campos suportados. |
| `create_project_draft` | Cria um card do tipo Draft Issue em um projeto. |
| `update_project_single_select` | Define o valor de um campo de seleção única, como Status ou Prioridade. |
| `delete_project_item` | Remove um item de um projeto. |

Endpoints HTTP:

- `GET /health` — verificação de saúde do serviço.
- `POST /mcp` — endpoint MCP Streamable HTTP autenticado.

## Requisitos

- Node.js 22 ou Docker.
- Um GitHub Personal Access Token (classic) com o escopo `project` para Projects V2 pertencentes a uma conta pessoal do GitHub.
- O usuário ou organização do GitHub proprietário dos projetos.

## Configuração

Clone o repositório e crie o arquivo de ambiente:

```bash
cp .env.example .env
```

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GITHUB_TOKEN` | Sim | Personal Access Token (classic) com o escopo `project` (**Full control of projects**) para Projects V2 de conta pessoal. |
| `MCP_ACCESS_TOKEN` | Sim | Segredo forte e privado usado para autenticar chamadas ao endpoint MCP. |
| `GITHUB_OWNER` | Sim | Login do usuário ou organização do GitHub proprietária dos projetos. |
| `PORT` | Não | Porta HTTP interna. O padrão é `80`. |

### Como gerar o token do GitHub

Para Projects V2 pertencentes a uma conta pessoal do GitHub:

1. Acesse [Configurações de tokens do GitHub — Tokens (classic)](https://github.com/settings/tokens).
2. Selecione **Generate new token (classic)**.
3. Informe um nome descritivo.
4. Em **Select scopes**, marque `project` — **Full control of projects**. O GitHub também marcará `read:project` automaticamente; isso é esperado.
5. Gere o token e copie-o. O GitHub exibe o valor apenas uma vez.

Não marque o escopo `repo` apenas para administrar quadros de projetos.

Atualmente, tokens fine-grained não conseguem acessar Projects pertencentes a uma conta pessoal. Para Projects V2 de organizações, tokens fine-grained oferecem a permissão **Projects** no nível da organização, sujeitos à política de tokens e às exigências de aprovação da organização.

### Gerar o segredo de acesso MCP

Gere um segredo separado para autenticar o MCP. Por exemplo:

```bash
openssl rand -hex 32
```

Mantenha o token do GitHub separado do token de acesso MCP. Os valores de `.env.example` são apenas exemplos. Nunca versione o arquivo `.env` nem exponha qualquer um dos tokens.

## Execução local

```bash
npm install
npm start
```

Por padrão, o servidor escuta em `0.0.0.0:80`.

```bash
curl http://localhost:80/health
```

Resposta esperada:

```json
{"ok":true,"service":"github-projects-bridge"}
```

## Execução com Docker

```bash
docker build -t github-projects-bridge .
docker run -d \
  --name github-projects-bridge \
  -p 80:80 \
  --env-file .env \
  github-projects-bridge
```

## Deploy no Easypanel

1. Crie um serviço do tipo **App** conectado a este repositório do GitHub.
2. Selecione **Dockerfile** como método de build e utilize o Dockerfile da raiz.
3. Cadastre as variáveis de ambiente listadas acima nas configurações do serviço. Não versione um arquivo `.env`.
4. Configure a porta interna como `80` e associe um domínio com HTTPS.
5. Faça o deploy e verifique `https://SEU-DOMINIO/health`.

O endpoint MCP será `https://SEU-DOMINIO/mcp`. As requisições devem incluir:

```http
Authorization: Bearer SEU_MCP_ACCESS_TOKEN
```

O endpoint de saúde é público e não exige o token MCP.

## Conectar um cliente MCP

Configure seu cliente compatível com MCP para utilizar a URL HTTPS `/mcp` e forneça o token de acesso por meio de autenticação HTTP Bearer. O cliente precisa oferecer suporte ao transporte MCP Streamable HTTP e a cabeçalhos de autorização personalizados.

## Segurança

- Exponha o serviço por meio de um proxy reverso com HTTPS; não publique diretamente a porta do contêiner na internet.
- Mantenha `GITHUB_TOKEN` e `MCP_ACCESS_TOKEN` privados e utilize valores diferentes.
- Para Projects V2 de uma conta pessoal, utilize somente o escopo `project` do token clássico; não adicione `repo` a menos que outra funcionalidade exija acesso a repositórios.
- Armazene os segredos nas configurações de ambiente da plataforma de deploy, não no controle de versão.
- Altere as duas credenciais caso exista suspeita de exposição.
- Restrinja o acesso ao projeto Easypanel e às respectivas variáveis de ambiente.

## Licença

Este repositório ainda não especifica uma licença.
