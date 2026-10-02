# GitHub Projects Bridge

Servidor MCP remoto para gerenciar GitHub Projects V2 via GraphQL, preparado para deploy no Easypanel.

## Recursos

- Listar Projects V2 de usuários e organizações.
- Consultar projetos, campos e opções.
- Listar cards e valores dos campos.
- Criar cards do tipo Draft Issue.
- Alterar campos Single Select, como Status e Prioridade.
- Remover cards de projetos.

## Configuração

1. Copie `.env.example` para `.env`.
2. Preencha `GITHUB_TOKEN` com um fine-grained Personal Access Token do GitHub com a permissão **Projects: Read and write**.
3. Preencha `MCP_ACCESS_TOKEN` com um segredo aleatório forte e exclusivo. Você pode gerar um com `openssl rand -hex 32`.
4. Em `GITHUB_OWNER`, informe o login do usuário ou da organização proprietária dos projetos.
5. Mantenha `PORT=3000`, salvo se sua hospedagem exigir outra porta.

Os valores de `.env.example` são apenas marcadores, não credenciais funcionais. Nunca publique o arquivo `.env` nem compartilhe seus tokens.

## Deploy no Easypanel

1. Crie um serviço do tipo **App** conectado a este repositório.
2. Selecione build por **Dockerfile**.
3. Cadastre no painel as mesmas variáveis listadas em `.env.example`, substituindo os marcadores pelos valores reais. Não é necessário criar um arquivo `.env` no repositório.
4. Configure um domínio e habilite HTTPS.
5. Faça o deploy.
6. Teste `https://SEU-DOMINIO/health`. A resposta esperada é `{"ok":true,"service":"github-projects-bridge"}`.

O endpoint MCP será `https://SEU-DOMINIO/mcp`, autenticado por `Authorization: Bearer SEU_MCP_ACCESS_TOKEN`.

## Token GitHub

Crie um fine-grained PAT em GitHub → Settings → Developer settings → Personal access tokens. Conceda somente os acessos necessários e habilite **Projects: Read and write**. Para projetos de organização, a organização pode exigir aprovação do token.

## Integração com ChatGPT

Este serviço implementa MCP remoto via Streamable HTTP. Para usá-lo como ferramenta no ChatGPT, será necessário adicionar o servidor MCP como conector/app personalizado em um ambiente que permita configurar endpoint e autenticação Bearer. A disponibilidade depende do plano e das configurações da conta. O conector GitHub já instalado não passa a enxergar este endpoint automaticamente.

## Segurança

- Não exponha a porta diretamente; use o proxy HTTPS do Easypanel.
- Use um segredo MCP diferente do token GitHub.
- Restrinja o token GitHub ao escopo mínimo necessário.
- Rotacione os segredos se houver suspeita de exposição.
- O arquivo `.env` está no `.gitignore`; mantenha-o fora do Git.
