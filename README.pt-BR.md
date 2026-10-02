# GitHub Projects Bridge

Servidor remoto do [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para gerenciar GitHub Projects V2 por meio da API GraphQL do GitHub. Disponibiliza ferramentas para localizar projetos e gerenciar seus cards via Streamable HTTP. Foi projetado para executar em um contêiner leve, inclusive no Easypanel.

**Documentação:** [English](README.md)

## Recursos

Atualmente, o servidor disponibiliza estas ferramentas MCP:

| Ferramenta | Descrição |
| --- | --- |
| `list_projects` | Lista os Projects V2 pertencentes a um usuário ou organização do GitHub. |
| `get_project` | Consulta um projeto, incluindo seus campos e opções de seleção única. |
| `list_project_items` | Lista os itens do projeto, seus conteúdos e os valores dos campos suportados. |
| `create_project_draft` | Cria um card do tipo Draft Issue em um projeto. |
| `update_project_single_select` | Define o valor de um campo de seleção única, como Status ou Prioridade. |
| `delete_project_item` | Remove um item de um projeto. |

O serviço HTTP disponibiliza:

- `GET /health` — verificação de saúde do serviço.
- `POST /mcp` — endpoint MCP Streamable HTTP autenticado.

## Requisitos

- Node.js 22 ou Docker.
- Um GitHub fine-grained Personal Access Token (PAT).
- Um usuário ou organização do GitHub proprietário dos Projects V2 que serão gerenciados.

## Configuração

Clone o repositório e crie o arquivo de ambiente:

```bash
cp .env.example .env
```

Configure as seguintes variáveis no arquivo `.env`:

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GITHUB_TOKEN` | Sim | GitHub fine-grained PAT com permissão **Projects: Read and write**. |
| `MCP_ACCESS_TOKEN` | Sim | Segredo forte e privado usado para autenticar as chamadas ao endpoint MCP. |
| `GITHUB_OWNER` | Sim | Login do usuário ou da organização do GitHub proprietária dos projetos. |
| `PORT` | Não | Porta HTTP interna. O padrão é `3000`. |

Gere um segredo exclusivo para o acesso MCP. Por exemplo:

```bash
openssl rand -hex 32
```

Mantenha o token do GitHub separado do token de acesso MCP. Os valores de `.env.example` são apenas exemplos, não são credenciais funcionais. Nunca versione o arquivo `.env` nem exponha qualquer um dos tokens.

### Permissões do token GitHub

Crie um fine-grained PAT em **GitHub → Settings → Developer settings → Personal access tokens**. Conceda a permissão **Projects: Read and write** para a conta ou organização relevante. Projetos pertencentes a organizações podem exigir aprovação do token pelo administrador da organização.

Conceda somente o escopo mínimo necessário para os projetos que serão gerenciados.

## Execução local

Instale as dependências e inicie o servidor:

```bash
npm install
npm start
```

Por padrão, o servidor escuta em `0.0.0.0:3000`. Verifique o endpoint de saúde:

```bash
curl http://localhost:3000/health
```

Resposta esperada:

```json
{"ok":true,"service":"github-projects-bridge"}
```

## Execução com Docker

Crie a imagem e execute o contêiner, fornecendo as variáveis de ambiente configuradas no seu ambiente de deploy:

```bash
docker build -t github-projects-bridge .
docker run -d \
  --name github-projects-bridge \
  -p 3000:3000 \
  --env-file .env \
  github-projects-bridge
```

## Deploy no Easypanel

1. Crie um serviço do tipo **App** conectado a este repositório do GitHub.
2. Selecione **Dockerfile** como método de build e utilize o `Dockerfile` localizado na raiz do repositório.
3. Cadastre nas configurações do serviço do Easypanel as variáveis descritas na seção [Configuração](#configuração). Informe os valores reais; não adicione um arquivo `.env` ao repositório.
4. Configure a porta interna do serviço como `3000` e associe um domínio com HTTPS.
5. Faça o deploy.
6. Verifique se `https://SEU-DOMINIO/health` retorna a resposta esperada.

O endpoint MCP será:

```text
https://SEU-DOMINIO/mcp
```

As requisições para `/mcp` devem incluir o seguinte cabeçalho HTTP:

```http
Authorization: Bearer SEU_MCP_ACCESS_TOKEN
```

O endpoint de saúde é público e não exige o token de acesso MCP.

## Conectar um cliente MCP

Configure seu cliente compatível com MCP para utilizar a URL HTTPS `/mcp` do servidor e forneça o token de acesso por meio de autenticação HTTP Bearer. O cliente precisa oferecer suporte ao transporte MCP Streamable HTTP e a cabeçalhos de autorização personalizados.

A configuração varia conforme o produto e sua versão. O conector GitHub nativo de um cliente não se conecta automaticamente a este servidor: adicione o endpoint como um servidor/conector MCP separado, em clientes que permitam conexões MCP personalizadas.

## Segurança

- Exponha o serviço por meio de um proxy reverso com HTTPS; não publique diretamente a porta do contêiner na internet.
- Mantenha `GITHUB_TOKEN` e `MCP_ACCESS_TOKEN` privados e utilize valores diferentes.
- Restrinja o token GitHub à permissão Projects necessária e ao escopo de conta adequado.
- Armazene os segredos nas configurações de ambiente da plataforma de deploy, não no controle de versão.
- Altere as duas credenciais caso exista suspeita de exposição.
- Restrinja o acesso ao projeto Easypanel e às respectivas variáveis de ambiente.

## Licença

Este repositório ainda não especifica uma licença.