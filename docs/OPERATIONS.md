# Runbook operacional

## API lenta ou frontend sem dados

1. Abra `/health` na API. `200 {"status":"ok"}` confirma que o processo responde, **não** que o banco está saudável.
2. Consulte `/sessions` e confira o status HTTP. Um catálogo vazio com 200 pode significar que as datas demo passaram; 500 exige examinar o banco e logs.
3. Nas páginas públicas, aguarde a recuperação limitada de cold start. Falha final oferece Tentar novamente. Não repita pagamento ou reserva automaticamente: consulte o estado conhecido primeiro.
4. Confira `VITE_API_URL` no build do frontend, `WEB_ORIGIN` na API e `connect-src` em `apps/web/vercel.json`. Alterar variável Vite exige rebuild. CORS não substitui autenticação.
5. Confira logs Railway, disponibilidade do serviço e conexão com PostgreSQL. Não cole tokens, URLs de conexão ou credenciais de ingresso em tickets públicos.

## Banco e migrations

```bash
npm run db:up
npm run db:check
npm run db:migrate:deploy
```

`db:check` consulta a conexão configurada. Verifique host, porta, credenciais e disponibilidade do banco se falhar. No Railway, use a conexão adequada ao ambiente de execução; não substitua um hostname privado por uma URL inventada.

Em instalação nova, aplique as sete migrations antes do seed. Não use `prisma db push` para substituir o histórico SQL: o índice parcial de alocação ativa é mantido pela migration. Não edite migrations já aplicadas.

```bash
npm run db:seed
```

Seed é exclusivo de demonstração: altera datas/senhas e pode restaurar o ingresso usado ainda alocado. Ele não limpa tudo. Use banco isolado para testes e nunca agende seed no restart da API.

A renomeação de packages não renomeia bancos ou volumes existentes. Em instalações locais anteriores, mantenha no `.env` o usuário e banco realmente provisionados, ou prepare outro banco com os defaults novos. Não remova volumes para corrigir nomes.

## Validação reproduzível

Com PostgreSQL local dedicado, defina `DATABASE_URL`, aplique migrations e seed e rode:

```bash
npm ci
npm run check
npm run test:concurrency-proof
```

A prova exige `DATABASE_URL` no ambiente do shell e permissão de criar banco. No PowerShell, use `$env:DATABASE_URL = 'postgresql://...'`. Ela cria um banco próprio `septem_proof_<uuid>`, copia a API para o diretório temporário do sistema e verifica falhas específicas por relatório JSON. Não opera nas tabelas do banco indicado originalmente.

Se o processo for morto pelo sistema, procure bancos com esse prefixo e diretórios temporários `septem-proof-*`. Confirme que não há runner ativo e que pertencem a uma execução encerrada antes de removê-los. Não use exclusão por wildcard em um servidor compartilhado.

## SSE sem atualização

1. Em Network, confirme `GET /sessions/:id/events` com `text/event-stream`, `sync` inicial e comentários keep-alive. Rascunhos e sessões já iniciadas não abrem stream público.
2. Verifique se o proxy preserva streaming sem buffer. A API envia `X-Accel-Buffering: no`, keep-alive a cada 25 segundos e reconexão sugerida de cinco segundos.
3. Confira o GET de assentos, que é a fonte autoritativa. Mapa e métricas do editor têm polling de oito segundos quando a página está visível.
4. Em múltiplas réplicas, perder um evento entre processos é limitação conhecida. A integridade da reserva não depende do SSE. Um cliente lento pode ser desconectado intencionalmente para limitar o buffer.

## TMDb indisponível

O catálogo do organizador pode retornar TMDB_NOT_CONFIGURED, TMDB_TIMEOUT ou TMDB_UPSTREAM_ERROR. Confira o Read Access Token somente no backend. O timeout é de cinco segundos; snapshots existentes continuam funcionando. Não exponha o token com prefixo VITE_.

## Deploy e rollback

1. Rode check e mutation proof antes do push. O repositório é `daniel-moulaz/septem-cinemas`; o domínio real gerado para a API permanece o listado no README.
2. Railway usa a raiz do monorepo, Railpack, build/start de `@septem/api`, migrations em pre-deploy e `/health`. Configure segredos distintos, DATABASE_URL, WEB_ORIGIN e API_HOST conforme o ambiente. PORT é fornecida pela plataforma.
3. Ative TRUST_PROXY somente atrás do proxy controlado da hospedagem, garantindo que ele sobrescreva headers encaminhados. Sem isso, IP de origem e HSTS podem ser interpretados incorretamente.
4. Vercel usa `apps/web`; `vercel.json` aplica rewrite SPA e headers. Se mudar a origem da API, ajuste a CSP e VITE_API_URL juntos. `camera=(self)` permite o scanner; imagens TMDb são explicitamente autorizadas.
5. Smoke: programação → sessão → assentos; login cliente → reserva → aprovação → ingresso; organizador → criar/editar/publicar; portaria → VALID e ALREADY_USED. Use ingressos criados para o smoke para preservar a demonstração.
6. Em regressão, reverta para um commit/deployment conhecido e compatível com o schema aplicado. Migrations não têm rollback automático: preserve backup e prefira correção incremental quando o código anterior não puder ler o schema atual. Nunca faça reset do banco para reverter código.

Nesta rodada os emissores/audiências dos tokens passaram à identidade SEPTEM. Isso encerra compatibilidade com JWT e QR já renderizados antes do rollout. Faça novo login e reabra ingressos para obter QR atualizado; o código manual e os dados persistidos não mudam. Publique API e frontend de forma coordenada e evite janela de portaria com QRs antigos impressos.

## Logs e investigação

Correlacione o request ID dos logs Fastify com horário, endpoint e status. O contrato público retorna apenas error/message; detalhes da exceção permanecem nos logs internos. URLs bearer de compartilhamento e parâmetros de busca são omitidos dos logs de requisição da API. Verifique separadamente a retenção e proteção de logs do proxy.

`npm audit` deve ser revisado junto ao lockfile. Os overrides de deepmerge-ts e mysql2 são restritos ao tooling Prisma; revise sua remoção ao atualizar para uma versão estável que incorpore as correções. Evite `npm audit fix --force` sem verificar compatibilidade.
