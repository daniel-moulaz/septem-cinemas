# Arquitetura

## Visão geral

A solução é um monólito modular com frontend e backend separados no mesmo repositório. O navegador nunca acessa a TMDb nem o PostgreSQL diretamente.

```text
React/Vite ──HTTP/JSON──> Fastify ──Prisma/SQL──> PostgreSQL
                              │
                              └────HTTPS────> TMDb
```

Estrutura atual, sem pacote compartilhado prematuro:

```text
apps/
  web/          # páginas, componentes e acesso à API
  api/          # módulos HTTP, regras de negócio e persistência
docs/           # requisitos, arquitetura, decisões e uso de IA
compose.yaml    # PostgreSQL local; web/API são opcionais
```

## Responsabilidades

### Frontend

O React organiza telas por jornada: catálogo e sessão, checkout, ingressos, organizador e portaria. Uma camada HTTP centraliza URL, token e normalização de erros. Estado permanece local às features; não haverá biblioteca global sem necessidade concreta.

Proteções de rota melhoram a UX, mas não substituem autorização no backend. Toda tela inclui loading, estado vazio, erro recuperável e feedback da ação.

### Backend

O Fastify é dividido por domínio: `auth`, `movies`, `sessions`, `reservations`, `payments`, `tickets`, `sharing` e `gate`. Cada módulo contém rotas e schemas Zod, serviço com a regra de negócio e acesso Prisma/SQL. Plugins comuns cuidam de configuração, autenticação, erros e Swagger.

As rotas validam contrato, identidade, papel e ownership. Serviços coordenam transações. O PostgreSQL mantém as garantias finais de unicidade e transição de estado.

A especificação OpenAPI descreve as operações reais da API e fica disponível com Swagger UI em `/docs` e como JSON em `/docs/json`. Os schemas Zod existentes continuam sendo a fonte da validação em runtime; sua conversão para JSON Schema ocorre somente durante a geração da documentação, sem introduzir uma segunda camada de validação.

## Modelo conceitual

| Entidade | Dados e relações principais | Garantias e índices |
|---|---|---|
| `User` | e-mail, `passwordHash`, papel | e-mail único |
| `Session` | organizador, snapshot TMDb, horário, local, preço em centavos, status | índices por `status/startsAt` e `organizerId`; edição condicionada à ausência de consequência comercial |
| `Seat` | sessão, fileira, número e label | `UNIQUE(sessionId, label)` |
| `Reservation` | cliente, sessão, status, `expiresAt`, total | índices por cliente, sessão, status e expiração |
| `ReservationSeat` | reserva, assento, preço unitário e `releasedAt` | índice único parcial em `seatId WHERE releasedAt IS NULL`; vínculos liberados permanecem como histórico |
| `Payment` | reserva, valor, resultado e timestamps | `UNIQUE(reservationId)`; valor vindo do backend |
| `Ticket` | sessão, assento reservado, código manual, status, `usedAt` e GATE responsável | estados `VALID`, `USED` e `CANCELLED`; vínculo e código únicos; índices por sessão e status |
| `SharedTicketLink` | ingresso, `tokenHash`, expiração/revogação | ingresso e hash únicos; token puro nunca é persistido |

O snapshot do filme fica em `Session` (`tmdbId`, título, pôster, backdrop, sinopse, data de lançamento e duração quando disponíveis). Uma tabela separada não agrega valor ao MVP. Datas são armazenadas em UTC e valores monetários em centavos. O resumo público expõe `tmdbId`, backdrop e duração de forma aditiva para agrupar sessões do mesmo filme e compor a Home sem consultas adicionais à API da TMDb e sem expor o token; as imagens públicas continuam vindo do CDN da própria TMDb.

Estados mínimos:

- sessão: `DRAFT -> PUBLISHED`;
- reserva: `PENDING -> PAID | EXPIRED | CANCELLED` e `PAID -> CANCELLED`;
- pagamento: `APPROVED | DECLINED` como resultado final da simulação;
- ingresso: `VALID -> USED | CANCELLED`.

O cliente pode cancelar a compra paga inteira dentro da política descrita abaixo. Cancelamento da sessão pelo organizador e reembolso financeiro continuam fora do escopo atual.

## Fluxos críticos

### Sessão e TMDb

O organizador pesquisa pelo backend. A API trata timeout, indisponibilidade e respostas inválidas da TMDb. Ao criar o rascunho, salva um snapshot; a exibição futura não depende do catálogo externo. A chave existe somente no ambiente da API. Cache distribuído não é necessário.

Sessões `DRAFT` aceitam edição livre. Uma sessão `PUBLISHED` continua editável enquanto a alteração for comprovadamente segura, conforme a política descrita abaixo; publicar deixou de ser, por si só, um motivo de bloqueio.

### Editabilidade de sessão publicada

O backend deriva a política com o relógio do PostgreSQL e a expõe no contrato do organizador como `editability: { allowed, reason, layoutEditable }`. O frontend apenas apresenta o resultado.

Bloqueiam: sessão já iniciada (`SESSION_STARTED`), hold `PENDING` dentro do prazo com alocação ativa (`ACTIVE_HOLD`) e histórico comercial — reserva `PAID` ou qualquer `Ticket` emitido, inclusive `USED` e `CANCELLED` (`COMMERCIAL_HISTORY`). Não bloqueiam: hold expirado e liberado, reserva `EXPIRED` sem ingresso e pagamento `DECLINED` sem ingresso. A política nunca é `EXISTS Reservation`.

Quando permitida, a edição cobre snapshot do filme, data/hora, local, endereço, sala, preço e layout; a sessão permanece `PUBLISHED` e `publishedAt` é preservado. Reconstruir o layout apaga e recria `Seat`, e as FKs de `ReservationSeat` usam `RESTRICT`: por isso `layoutEditable` é falso quando existe qualquer alocação histórica para os assentos, e a tentativa retorna `SESSION_LAYOUT_NOT_EDITABLE` sem impedir a edição dos demais campos.

A concorrência segue a ordem global `Session -> Seat -> Reservation -> ReservationSeat -> Ticket`. A criação de hold adquire `Session FOR SHARE` antes de ler preço e estrutura, e a edição adquire `Session FOR UPDATE`. Reservas concorrentes não se bloqueiam entre si, mas excluem a edição: se a reserva vence, a edição espera, revalida sob lock e é recusada pelo hold; se a edição vence, a reserva espera e lê o preço novo. Nenhuma reserva nasce sobre preço ou layout obsoletos. Pagamento, portaria e cancelamentos não travam `Session`, então prefixá-la à ordem não inverte lock algum. A editabilidade é sempre revalidada dentro da transação: o campo do `GET` é indicativo para a UI, nunca a autorização final.

### Painel operacional do organizador

O detalhe e a listagem do organizador expõem `metrics`, calculadas pelo backend em consulta agregada — em lote na listagem, sem N+1. Cada agregado usa subconsultas independentes sobre `ReservationSeat`, evitando multiplicação por produto cartesiano.

`capacity` é o total de `Seat`; `heldSeats` são alocações ativas de reservas `PENDING` dentro do prazo; `soldSeats` são alocações ainda ativas de reservas `PAID`; `availableSeats` é a diferença; `occupancyPercentage` trata `capacity = 0` como zero. `simulatedRevenueCents` é a receita operacional **vigente**: a soma de `unitPriceCents` das mesmas alocações contadas em `soldSeats`. Ela difere deliberadamente do histórico financeiro bruto — após um cancelamento individual, o assento sai da receita vigente enquanto o `Payment` aprovado permanece intacto. Um ingresso `USED` continua contando.

### Duplicação de sessão

`POST /organizer/sessions/:id/duplicate` cria um novo `DRAFT` a partir de uma sessão própria, `DRAFT` ou `PUBLISHED`, copiando apenas estrutura: snapshot do filme já persistido, local, endereço, sala, preço e formato do layout, com `Seat` de identificadores novos. `Reservation`, `ReservationSeat`, `Payment`, `Ticket` e `SharedTicketLink` nunca são copiados, `publishedAt` nasce nulo e a TMDb não é consultada novamente. Tudo em uma transação: falha na criação dos assentos não deixa sessão órfã.

### Hold e concorrência

O hold dura 10 minutos e usa o relógio do banco. Todas as operações que disputam ou liberam assentos preservam a seguinte ordem quando as entidades participam da transação:

1. bloquear linhas de `Seat` por `id` crescente;
2. bloquear as `Reservation` relacionadas por `id` crescente;
3. bloquear e revalidar os `ReservationSeat` ativos relacionados;
4. bloquear os `Ticket` relacionados por `id` crescente quando a operação puder mudar seu estado;
5. validar estados e horários com o relógio do banco e persistir todas as transições na mesma transação.

Na criação, a transação libera claims `PENDING` expirados, rejeita claims ainda ativos ou pagos e insere a nova reserva. Uma alocação é ativa somente quando `releasedAt IS NULL`; o índice único parcial `ReservationSeat_active_seatId_key` sobre esses vínculos é a garantia final contra corrida e permite que o mesmo assento seja reservado novamente após a liberação.

Esse índice existe exclusivamente na migration SQL e não é declarado como `@@unique` no schema Prisma. No Prisma 7.9.1, modelar o índice parcial dessa forma faria o Client expor `findUnique({ seatId })` como se `seatId` fosse globalmente único; depois de haver linhas históricas e uma ativa para o mesmo assento, a consulta poderia devolver uma linha liberada sem aplicar o predicado. Por isso, o Client reconhece apenas `id` e a chave composta como identificadores únicos de `ReservationSeat`, e as buscas por alocação ativa usam consultas filtradas com `releasedAt: null`.

A expiração é lazy: consulta de disponibilidade, nova disputa e pagamento podem encontrá-la. A liberação marca a reserva como `EXPIRED` e preenche `releasedAt` nos vínculos ativos com o relógio do PostgreSQL, sem apagar as linhas. Todas as consultas de disponibilidade, ocupação ou conflito consideram apenas `releasedAt IS NULL`. Não há cron/job. Erros de unicidade viram conflito de domínio, nunca venda dupla.

### Pagamento e emissão

O cliente envia somente o cenário reproduzível `APPROVED` ou `DECLINED`; a API recalcula valor e valida ownership. O pagamento adquire locks na mesma ordem do hold. Se a reserva já expirou, ela é expirada e liberada atomicamente.

Na aprovação, uma transação registra `Payment`, move a reserva para `PAID` e cria um `Ticket` por assento. Na recusa, registra `DECLINED`, move a reserva para `CANCELLED` e marca suas alocações ativas como liberadas. Nenhum ingresso existe antes do commit aprovado.

As FKs de `Payment` e `Ticket` usam `RESTRICT` sobre a reserva paga e sua alocação. Não existe fluxo de exclusão de reserva paga: `Payment`, `Ticket` e `ReservationSeat` preservam o histórico, enquanto somente uma alocação ativa é fonte de indisponibilidade.

### Cancelamento individual e da compra paga

Existem dois cancelamentos, ambos exigindo `CUSTOMER` autenticado e ownership sem revelar recursos de terceiros, e ambos limitados a ingressos ainda `VALID` de sessões ainda não iniciadas: `POST /me/tickets/:id/cancel` cancela um único ingresso; `POST /reservations/:id/cancel` cancela de uma vez todos os ingressos ainda `VALID` da compra. Nenhum dos dois afeta ingressos já `USED` ou já `CANCELLED`, nem o `Payment` aprovado, que permanece inalterado como histórico — não existe integração de estorno.

A `Reservation` não ganhou um estado "parcialmente cancelada": ela permanece `PAID` enquanto restar ingresso `VALID` ou `USED` e só transiciona para `CANCELLED` quando todos forem cancelados, seja pela rota individual, seja pela rota integral. Esse estado é sempre derivado dos `Ticket` da compra, nunca armazenado separadamente. Uma segunda chamada sobre um ingresso ou reserva já cancelados é conflito explícito (`TICKET_NOT_CANCELLABLE`, `RESERVATION_ALREADY_CANCELLED`), assim como sessão iniciada (`TICKET_SESSION_STARTED`, `RESERVATION_SESSION_STARTED`) e ingresso `USED` (`TICKET_NOT_CANCELLABLE` na rota individual, `RESERVATION_HAS_USED_TICKET` na rota integral, que rejeita a compra inteira mesmo que só um ingresso esteja `USED`). Reserva ou ingresso inexistente ou alheio retornam `RESERVATION_NOT_FOUND`/`TICKET_NOT_FOUND`; `RESERVATION_NOT_CANCELLABLE` cobre uma reserva que nunca chegou a `PAID`.

Dentro de uma única transação, cada rota bloqueia `Seat -> Reservation -> ReservationSeat -> Ticket` — a individual restrita ao único assento/ingresso do alvo, a integral às coleções ativas da reserva inteira, sempre ordenando por ID — usa o relógio do PostgreSQL e revalida todas as precondições. Em seguida, move o(s) ingresso(s) para `CANCELLED`, preenche `releasedAt` na(s) alocação(ões) correspondente(s) e, se for o caso, move a reserva para `CANCELLED`. As contagens de linhas alteradas também são conferidas antes do commit. A rota integral tolera uma compra parcialmente cancelada: ela ignora os ingressos já `CANCELLED` e transiciona apenas os que ainda estão `VALID`.

Essa ordem coordena qualquer um dos dois cancelamentos com o Gate. Se o consumo condicional obtiver primeiro o lock do ingresso, ele o move para `USED` e o cancelamento, após esperar, rejeita a operação sem liberar o lugar. Se o cancelamento obtiver primeiro o lock, a portaria não consegue executar `VALID -> USED`, relê `CANCELLED` e responde `INVALID`. O commit nunca combina acesso concedido com assento liberado. A mesma ordem também serializa o cancelamento com uma nova reserva disputando o assento recém-liberado, garantindo no máximo uma alocação ativa por vez.

### Disponibilidade em tempo real

`GET /sessions/:id/events` é um stream Server-Sent Events de uma sessão publicada. Ele transporta apenas sinais de invalidação — `sync` na abertura e em cada reconexão, `seats-changed` a cada mudança real de disponibilidade —, sempre com o payload mínimo `{ "sessionId" }`. Nenhum evento carrega assento, reserva, ingresso, credencial, token ou identidade; ao recebê-los, o cliente refaz `GET /sessions/:id/seats`, que permanece o snapshot autoritativo derivado do PostgreSQL. Um evento nunca define estado, e por isso perdê-lo não corrompe nada.

A publicação ocorre exclusivamente depois do commit das transações que alteram disponibilidade: criação de hold, liberação de holds vencidos, pagamento recusado, pagamento aprovado (`HELD` passa a `SOLD` na leitura pública), cancelamento individual e cancelamento integral. Uma transação que sofre rollback não publica nada.

O fanout usa um broadcaster em memória por `sessionId`, sem Redis, WebSocket, fila ou broker. Cada stream envia um comentário de keep-alive periódico, declara o `retry` do cliente e é encerrado no hook `preClose` do Fastify — `onClose` só roda depois das requisições em voo, e um stream SSE nunca termina sozinho. A limitação conhecida é a topologia: com múltiplas réplicas da API, invalidações não cruzam processos e a atualização volta a depender do polling; a evolução natural seria `LISTEN/NOTIFY` no PostgreSQL, ainda não implementada por não ser necessária à correção.

No frontend, a página da sessão mantém um único `EventSource` por sessão e um refresh com single-flight: uma invalidação que chegue durante um fetch em andamento marca o snapshot como sujo e dispara mais uma rodada ao final, de modo que nenhum sinal seja descartado e nenhuma resposta antiga sobrescreva uma mais nova. O polling de oito segundos permanece como rede de segurança para eventos perdidos, reconexões e navegadores sem `EventSource`.

A expiração de um hold continua decidida por `expiresAt` e pelo relógio do PostgreSQL. Para que o assento reapareça sem esperar uma nova requisição, um temporizador por reserva publica uma invalidação no instante do vencimento; ele é puro atalho de latência visual, e perdê-lo — em um restart, por exemplo — apenas adia a atualização até o próximo `sync`, polling ou consulta.

### QR e consumo

O QR contém um JWT/JWS HS256 com payload mínimo: versão, tipo, `jti` do ingresso, `sid` da sessão e claims de emissor, audiência e validade. `TICKET_SIGNING_SECRET` é forte, exclusivo e separado do segredo de login; o algoritmo aceito é fixado no verificador.

O token não é persistido: o backend o gera a partir do ingresso e do snapshot da sessão a cada detalhe. A validade termina após a duração do filme — ou 180 minutos quando ausente — mais duas horas de margem.

O código para entrada manual também é aleatório, único e possui entropia suficiente para não ser enumerável na interface autenticada da portaria.

A portaria escolhe a sessão, lê o QR pela câmera ou informa o código manual. A API valida assinatura e claims e confirma ingresso, sessão e status no banco. O consumo usa update condicional equivalente a:

```sql
UPDATE "Ticket"
SET
  status = 'USED',
  "usedAt" = clock_timestamp(),
  "usedByGateId" = $3
WHERE id = $1 AND "sessionId" = $2 AND status = 'VALID';
```

Uma linha alterada produz `VALID`. A credencial inexistente, criptograficamente inválida ou ligada a ingresso `CANCELLED` produz `INVALID`; um ingresso não cancelado de outra sessão produz `WRONG_EVENT`; e um ingresso já consumido na sessão selecionada produz `ALREADY_USED`. Caso o update retorne zero depois de uma leitura `VALID`, uma releitura controlada identifica se outra portaria consumiu o ingresso ou se um cancelamento venceu a corrida. Assim, somente um dos concorrentes efetiva sua transição.

O frontend da portaria usa a câmera do dispositivo e decodificação QR no navegador, carregada somente nessa jornada. O scanner para antes de enviar a credencial, permanece parado durante a resposta e só reinicia após a ação explícita de validar o próximo ingresso. A entrada manual permanece disponível mesmo sem permissão ou câmera. Em produção, `getUserMedia` exige HTTPS.

### Compartilhamento

Ao compartilhar, a API gera 32 bytes criptograficamente aleatórios e devolve `/shared/:token`. Persiste apenas `SHA-256(token)`. O endpoint público calcula o hash, consulta o link e mostra o ingresso/QR sem dados pessoais enquanto o link estiver válido. Depois do cancelamento, um link já existente continua resolvendo para o estado `CANCELLED`, mas retorna `manualCode` e `qrToken` nulos; um ingresso cancelado não gera um novo link.

O link é uma credencial bearer: quem o recebe pode apresentar o ingresso. A resposta usa `Cache-Control: no-store` e `X-Robots-Tag: noindex, nofollow`. Não há transferência, revenda nem fluxo com fragmento e `POST /resolve`.

## Autenticação e autorização

Senhas usam Argon2id. O login emite JWT bearer com duração de 8 horas e segredo separado do ingresso. Um pre-handler autentica; guards verificam papel e serviços confirmam ownership na consulta ou mutação. IDs, papéis e preços recebidos do frontend nunca são aceitos como autoridade.

Contas são fornecidas por seed no MVP; cadastro e recuperação de senha não são necessários. Tentativas de login malsucedidas são limitadas por origem da requisição, e nunca por conta, antes da verificação do hash — manter a conta fora da chave impede que alguém torne o login de outro usuário indisponível de propósito. Toda resposta carrega `X-Content-Type-Options`, `Referrer-Policy` e `X-Frame-Options`, definidos em `onRequest` para alcançarem também o stream SSE (ADR-026).

O cenário demonstrativo versionado mantém quatro contas, catorze sessões publicadas de cinco filmes em três datas futuras, dois cinemas e quatro salas de layout fixo, dois rascunhos e, em banco recém-semeado, um único ingresso válido para a portaria. Os horários formam uma grade plausível de cinema e respeitam a duração do filme entre sessões da mesma sala. As datas são derivadas do calendário de `America/Sao_Paulo` a cada execução, com deslocamento em dias, de modo que a programação permanece futura sem depender de datas fixas no código. Apenas a sessão de Matrix das 15:40 recebe reserva paga, pagamento e ingresso, o mínimo para demonstrar bloqueio de edição e métricas; nenhuma outra sessão nasce com histórico transacional. IDs fixos, `upsert` e criação de assentos com `skipDuplicates` preservam a idempotência; o seed usa somente snapshots locais, não consulta a TMDb e não reativa alocações cujo `releasedAt` já foi preenchido.

## Contrato REST essencial

| Método e rota | Acesso | Finalidade |
|---|---|---|
| `POST /auth/login` | público | autenticar conta de demonstração |
| `GET /catalog/movies` | organizer | listar filmes em cartaz ou pesquisar TMDb com `?q=` |
| `GET /catalog/movies/:tmdbId` | organizer | obter detalhes do filme pelo backend |
| `GET /organizer/sessions` | organizer | listar sessões próprias |
| `POST /organizer/sessions` | organizer | criar rascunho e assentos |
| `GET/PATCH /organizer/sessions/:id` | owner | consultar ou editar sessão enquanto a alteração for segura |
| `POST /organizer/sessions/:id/duplicate` | owner | criar um novo rascunho copiando só a estrutura |
| `POST /organizer/sessions/:id/publish` | owner | publicar sessão válida |
| `GET /sessions` | público | listar e buscar sessões publicadas |
| `GET /sessions/:id` | público | obter detalhes |
| `GET /sessions/:id/seats` | público | obter disponibilidade atual |
| `GET /sessions/:id/events` | público | assinar invalidações de disponibilidade por SSE |
| `POST /reservations` | customer | criar hold para sessão e assentos informados |
| `GET /reservations/:id` | owner customer | consultar hold e normalizar expiração lazy |
| `POST /reservations/:id/payment` | owner customer | aprovar ou recusar simulação |
| `POST /reservations/:id/cancel` | owner customer | cancelar os ingressos ainda `VALID` da compra paga e liberar suas alocações |
| `GET /me/tickets` | customer | listar ingressos próprios |
| `GET /me/tickets/:id` | owner customer | abrir ingresso digital |
| `POST /me/tickets/:id/cancel` | owner customer | cancelar um ingresso `VALID` individual e liberar seu assento |
| `POST /me/tickets/:id/share-link` | owner customer | criar ou substituir link compartilhável |
| `DELETE /me/tickets/:id/share-link` | owner customer | revogar o link ativo |
| `GET /shared/:token` | público | abrir ingresso compartilhado sem cache |
| `GET /gate/sessions` | gate | escolher sessão publicada |
| `POST /gate/tickets/consume` | gate | validar e consumir QR/código no contexto da sessão escolhida |

## Execução, CI e deploy

Em desenvolvimento, o Compose contém apenas PostgreSQL; web e API rodam localmente para feedback rápido. Swagger/OpenAPI permite inspecionar e testar a API. No GitHub Actions, um único job usa PostgreSQL 17 real, instala pelo lockfile, gera o Prisma Client, aplica as migrations em banco vazio, carrega as fixtures exigidas pela suíte e executa lint, typecheck, testes e builds.

A aplicação está publicada com o frontend na Vercel e a API com PostgreSQL no Railway; as URLs estão no README. A API usa Railpack a partir da raiz do monorepo, respeita a `PORT` da plataforma, aplica `prisma migrate deploy` antes de iniciar e expõe `/health` para o rollout. O seed permanece uma operação única e manual depois do primeiro deploy; executá-lo em todo restart restauraria datas, senhas e o estado do ingresso demonstrativo.

Na Vercel, `apps/web` é a raiz do projeto e um rewrite entrega `index.html` para as rotas da SPA. `VITE_API_URL` aponta para a API pública; no backend, `WEB_ORIGIN` configura CORS e a origem dos links compartilhados. Após um rollout, o smoke em produção deve percorrer os três papéis, Swagger, compartilhamento e câmera via HTTPS. OPERATIONS.md descreve diagnóstico, rollout e rollback; HARDENING-REPORT.md registra o que foi efetivamente validado nesta rodada.

## Recuperação e manutenção do frontend

Leituras públicas passam por public-read.ts, com retries transitórios limitados, timeout e cancelamento. Escritas e autenticação não são repetidas automaticamente. ServerStartingNotice complementa os skeletons após 1,5 segundo.

SessionEditor apresenta o editor; useSessionEditor coordena carregamento e operações; useSessionForm mantém validação e dirty state; SessionPresentation concentra prévia e leitura operacional. Eventos são agregados durante um fetch e complementados por polling de oito segundos. Atualizações operacionais não substituem os campos em edição. Durante uma mutação, o refresh anterior é abortado para não sobrescrever seu resultado.

Ver CONCURRENCY-PROOF.md, KNOWN-LIMITATIONS.md e DECISIONS.md para as provas, limites e decisão sobre idempotência.

## Compatibilidade de credenciais

Novos JWTs de login e QR usam somente a identidade SEPTEM. Os validadores aceitam também os pares completos legítimos anteriores, mantendo separação de finalidade/segredo, assinatura, expiração e consulta ao estado atual do banco. Não há migração de dados: QR é derivado do mesmo ingresso persistido. No navegador, a chave atual tem prioridade; o token anterior é migrado após confirmação por /auth/me. Ver ADR-030 e OPERATIONS.md para retirada do suporte e rollout.
