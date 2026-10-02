# GitHub Projects Bridge

Servidor MCP remoto para gerenciar GitHub Projects V2 via GraphQL, preparado para deploy no Easypanel.

## Recursos

- Listar Projects V2 de usuários e organizações.
- Consultar projetos, campos e opções.
- Listar cards e valores dos campos.
- Criar cards do tipo Draft Issue.
- Alterar campos Single Select, como Status e Prioridade.
- Remover cards de projetos.

## Deploy no Easypanel

1. Crie um serviço do tipo **App** conectado a este repositório.
2. Selecione build por **Dockerfile**.
3. Configure as variáveis:
   - `GITHUB_TOKEN`: fine-grained Personal Access Token com `Projects: Read and write`.
   - `MCP_ACCESS_TOKEN`: segredo aleatório longo e exclusivo para proteger o endpoint MCP.
   - `GITHUB_OWNER`: login do usuário ou organização proprietária dos projetos.
   - `PORT=3000`.
4. Configure um domínio e habilite HTTPS.
5. Faça o deploy.
6. Teste `https://SEU-DOMINIO/health`. A resposta esperada é `{"ok":true,"service":"github-projects-bridge"}`.

O endpoint MCP será `https://SEU-DOMINIO/mcp`, autenticado por `Authorization: Bearer SEU_MCP_ACCESS_TOKEN`.

## Token GitHub

Crie um fine-grained PAT em GitHub → Settings → Developer settings → Personal access tokens. Conceda somente os acessos necessários e habilite **Projects: Read and write**. Para projetos de organização, a organização pode exigir aprovação do token. Nunca coloque o token no repositório.

## Integração com ChatGPT

Este serviço implementa MCP remoto via Streamable HTTP. Para usá-lo como ferramenta no ChatGPT, será necessário adicionar o servidor MCP como conector/app personalizado em um ambiente que permita configurar endpoint e autenticação Bearer. A disponibilidade depende do plano e das configurações da conta. O conector GitHub já instalado não passa a enxergar este endpoint automaticamente.

## Segurança

- Não exponha a porta diretamente; use o proxy HTTPS do Easypanel.
- Use um segredo MCP diferente do token GitHub.
- Restrinja o token GitHub ao escopo mínimo necessário.
- Rotacione os segredos se houver suspeita de exposição.
- Não versione arquivos `.env`.
