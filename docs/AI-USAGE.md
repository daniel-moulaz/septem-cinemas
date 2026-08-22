# Uso de IA

Este documento registra o uso real de IA como ferramenta de engenharia neste projeto.

Usei IA ao longo de todo o desenvolvimento: análise do enunciado, geração de alternativas, implementação, depuração, testes, revisão de código e documentação. Foi uma ferramenta relevante e o registro abaixo é honesto sobre isso, milestone a milestone, incluindo o que a ferramenta acertou, o que errou e o que foi descartado na revisão.

A autoria e a responsabilidade técnica pelo repositório são minhas. Eu defini o escopo e a direção de produto, avaliei cada sugestão antes de ela entrar no projeto, rejeitei o que não melhorava a solução, validei manualmente os fluxos críticos e respondo pelo resultado entregue. Onde uma verificação não aconteceu, está escrito que não aconteceu.

## Etapa de planejamento

Até a criação destes documentos, o trabalho foi de análise e documentação. Nenhuma aplicação, dependência, migration ou infraestrutura foi inicializada.

O desafio técnico oficial foi mantido como fonte de verdade durante todo o desenvolvimento. Ferramentas de IA foram utilizadas como apoio em planejamento, implementação, revisão e documentação, sempre com validação das decisões e do comportamento final da aplicação.

## Ferramentas e contribuições

### ChatGPT

Foi usado para discussão e revisão do briefing de planejamento, incluindo organização das perguntas, controle de escopo e pontos que exigiam análise crítica. Essa revisão utilizou um modelo OpenAI com raciocínio alto.

### Codex

Foi usado para:

- inspecionar o repositório e ler integralmente as fontes;
- separar requisitos oficiais, opcionais e decisões internas de entrega;
- analisar arquitetura, modelo de dados, concorrência de assentos, segurança do QR e consumo atômico;
- propor jornadas, API, testes, deploy, riscos, milestones e cortes de escopo;
- sintetizar o planejamento aprovado em `REQUIREMENTS.md`, `ARCHITECTURE.md`, `DECISIONS.md` e este registro.

Nesta etapa, o Codex não implementou código nem instalou dependências.

## Decisões e revisão humanas

Revisei o planejamento e aprovei explicitamente:

- foco exclusivo em cinema e uso da TMDb;
- deploy como P0 estratégico, embora opcional no enunciado;
- compartilhamento em `/shared/:token`, com token forte, hash no banco e `no-store`;
- hold de 10 minutos, expiração lazy e ordem de locks comum ao pagamento;
- QR HS256 com dados mínimos e confirmação do estado no banco;
- imutabilidade estrutural de sessões publicadas;
- teto aproximado de 20 horas e ordem dos primeiros cortes.

Também autorizei a transformação do plano nestes quatro documentos e mantive proibidos implementação, instalação, commit e alterações em outros arquivos.

## Validações desta etapa

- releitura das instruções vigentes do repositório;
- revisão cruzada dos quatro documentos e das decisões aprovadas;
- inspeção do diff completo;
- verificação de whitespace com `git diff --check`;
- conferência final do working tree.

Na etapa de planejamento descrita acima ainda não havia testes, typecheck, lint, build ou smoke test da aplicação. Esses resultados passaram a existir no M0 e estão registrados a seguir.

## M0 — Fundação

Em 18 de agosto de 2026, o Codex auxiliou no scaffold e na configuração da fundação técnica aprovada. O trabalho ficou restrito a:

- monorepo com npm workspaces;
- frontend mínimo em React, TypeScript e Vite;
- backend mínimo em Fastify e TypeScript, com `GET /health`;
- PostgreSQL local no Docker Compose;
- Prisma configurado sem models de domínio;
- lint, typecheck, teste de integração do health check e builds;
- documentação local mínima.

As escolhas de stack, simplicidade arquitetural e limite de escopo vieram do planejamento aprovado. O Codex consultou documentação oficial e o registro npm para compatibilizar versões estáveis, com destaque para Prisma 7, seu arquivo `prisma.config.ts` e o adapter PostgreSQL.

Verificações executadas localmente:

- instalação e resolução das dependências com npm;
- validação do Compose e PostgreSQL 17 em estado `healthy`;
- consulta SQL de conectividade no container;
- `prisma validate`, `prisma generate` e conexão `SELECT 1` pelo Prisma Client;
- `npm run lint`, `npm run typecheck`, `npm test` e `npm run build`;
- inicialização conjunta com `npm run dev` e respostas HTTP 200 do frontend e de `/health`;
- `git diff --check`.

Não houve validação visual humana nesta etapa. A automação do navegador integrado não iniciou por uma restrição interna de caminho confiável do ambiente; a página mínima foi verificada por build e resposta HTTP contendo a identificação do projeto.

## M1 — Autenticação, RBAC e usuários de demonstração

Em 18 de agosto de 2026, o Codex auxiliou na implementação do milestone aprovado de autenticação. O trabalho incluiu:

- model `User`, enum de papéis, migration e seed idempotente com quatro contas;
- hashing Argon2id, login JWT HS256 de oito horas e confirmação do usuário no PostgreSQL a cada requisição autenticada;
- guards reutilizáveis de RBAC, sem criar endpoints diagnósticos na aplicação;
- CORS restrito à origem configurada e respostas públicas sem `passwordHash`;
- frontend temporário de login, restauração por `/auth/me`, `sessionStorage` e área mínima por papel.

As decisões de stack e segurança vieram do planejamento aprovado. Durante a implementação, o Codex consultou as fontes oficiais dos plugins Fastify, Argon2 e seed do Prisma para confirmar compatibilidade e configuração. Uma revisão independente ajudou a identificar a necessidade de fixar HS256 na verificação, usar o papel atual do banco como autoridade do RBAC e não mascarar falhas do PostgreSQL como token inválido. Essa última correção recebeu teste de regressão. Rotas exclusivas de cada papel foram registradas somente nos testes, evitando poluir a API de produção.

Verificações executadas até esta atualização:

- Prisma formatado, validado e gerado;
- PostgreSQL local saudável e migration aplicada sem reset;
- seed executado duas vezes sem duplicar contas;
- lint e typecheck isolados da API;
- 19 testes automatizados passando, incluindo seed, login, JWT, `/auth/me`, RBAC, falha de banco e CORS;
- smoke HTTP de `/health`, login e `/auth/me` para as quatro contas de demonstração;
- builds da API e do frontend.

A validação visual automatizada continuou indisponível porque o navegador integrado recusou seu próprio caminho interno como não confiável. O frontend foi verificado por lint, typecheck, build e resposta HTTP, sem atribuir uma inspeção visual que não ocorreu.

A auditoria do npm também apontou o advisory [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), recém-publicado para `deepmerge-ts` transitivo do Prisma 7.9.1. O npm ofereceu somente downgrade incompatível do Prisma; não foram aplicados `--force` nem override sem suporte. A configuração Prisma deste projeto é estática e não recebe grafos de objetos de requisições, mas a dependência deve ser atualizada assim que houver versão estável compatível.

Não houve implementação de TMDb, sessões, assentos, reservas, pagamentos, ingressos ou qualquer item de M2. A revisão humana do M1 ainda não ocorreu.

## M2 — TMDb e gestão de sessões

Em 18 de agosto de 2026, o Codex auxiliou na implementação do fluxo do organizador aprovado para o M2. O trabalho incluiu:

- cliente TMDb isolado com `fetch` nativo, timeout, mapeamento mínimo e erros controlados;
- models `Session` e `Seat`, constraints do PostgreSQL e migrations sem entidades de milestones futuros;
- criação transacional de rascunho e assentos, edição restrita a `DRAFT`, ownership e publicação irreversível;
- frontend do organizador para catálogo, formulário, lista, edição e publicação, com atribuição oficial à TMDb;
- testes de integração com PostgreSQL real e fronteira externa simulada, sem chamar a TMDb nos testes.

As decisões vieram do planejamento aprovado: snapshot confiável obtido pelo backend, layout retangular de até 10 × 20 lugares e imutabilidade estrutural depois de `PUBLISHED`. Revisões independentes do Codex levaram a ajustes no timeout do corpo da resposta externa, limites do payload TMDb, isolamento dos testes locais, revalidação de horário antes da transação e comportamento do frontend quando o JWT expira. A checklist de boas práticas React orientou a separação dos componentes, efeitos abortáveis, estado derivado e acessibilidade básica, sem adicionar biblioteca.

Verificações executadas localmente:

- PostgreSQL 17 saudável, schema Prisma válido e três migrations aplicadas no total (duas do M2);
- Prisma Client gerado e conexão ao banco confirmada;
- lint, typecheck e builds da API e do frontend;
- 60 testes passando, incluindo RBAC, ownership, snapshot, rollback, publicação, falhas e timeout da TMDb;
- smoke HTTP do fluxo `login -> catálogo -> rascunho -> edição -> publicação`, usando catálogo falso somente na fronteira externa e removendo os dados criados ao final;
- frontend servido localmente com `GET /` respondendo 200;
- `git diff --check` e revisão de secrets ao término.

Não houve validação visual humana nesta etapa. O executável `agent-browser` não estava disponível no ambiente e a alternativa de navegador integrado não pôde carregar o Playwright; não foi instalada ferramenta adicional apenas para essa inspeção. A revisão humana do M2 ainda não ocorreu.

## M3 — Catálogo público e hold de assentos

Em 18 de agosto de 2026, o Codex auxiliou na implementação do catálogo de sessões publicadas, mapa acessível, fluxo do cliente e reserva temporária. A regra de concorrência seguiu o planejamento aprovado: preço e identidade vêm do backend, assentos são bloqueados em ordem determinística, o PostgreSQL fornece o relógio e `UNIQUE(ReservationSeat.seatId)` permanece como última defesa.

A expiração foi implementada de forma lazy, sem cron, fila ou cache. Revisões independentes levaram à captura de um único instante do banco para todo o mapa, à classificação correta dos conflitos no frontend e a ajustes de navegação e acessibilidade. O frontend permaneceu em React com estado local, sem gerenciador de estado ou dependências adicionais.

O PostgreSQL 17 permaneceu saudável, a migration foi aplicada e `npm run check` aprovou lint, typecheck, 81 testes e os dois builds. O teste concorrente foi repetido cinco vezes e sempre produziu um vencedor, um `409` e uma única alocação. Um smoke HTTP confirmou catálogo, detalhe, mapa, hold, ownership e conflito; sua fixture foi removida. A inspeção visual automatizada não ocorreu porque `agent-browser` não estava instalado e o runtime integrado não carregou Playwright. Não houve validação humana declarada nesta etapa.

## M4 — Pagamento simulado, ingresso e compartilhamento

Em 18 de agosto de 2026, o Codex auxiliou na implementação do pagamento síncrono aprovado, emissão atômica de ingressos, QR assinado e bearer link. A implementação preservou a ordem de locks definida no M3 e manteve preço, expiração, identidade e status sob autoridade do backend/PostgreSQL.

O trabalho incluiu `Payment`, `Ticket` e `SharedTicketLink`; cenários reproduzíveis `APPROVED`/`DECLINED`; código manual aleatório; JWS HS256 de payload mínimo e segredo separado; bilheteria do cliente; QR renderizado no frontend; e compartilhamento com 32 bytes aleatórios, somente SHA-256 persistido, rotação, revogação e respostas sem cache/PII. A única dependência nova foi `qrcode.react` 4.2.0, escolhida após consulta ao pacote e repositório oficiais por ser compatível com React 19 e não possuir dependências transitivas.

Revisões independentes do Codex levaram a quatro correções: colisão rara de código manual não é classificada como pagamento repetido; a tela limpa os assentos após recusa; a página compartilhada usa header sem identidade; e a troca de token reinicializa o componente. A configuração também rejeita reutilização do segredo de login como segredo do ingresso.

Verificações executadas localmente:

- PostgreSQL 17 saudável, cinco migrations aplicadas e Prisma validado/gerado;
- seed executado duas vezes, mantendo quatro contas, duas sessões e um ingresso demo;
- `npm run check` com lint, typecheck, 101 testes de integração e builds da API/web;
- teste concorrente com duas aprovações realmente aguardando o mesmo lock: um `200`, um `409`, um `Payment` e um ingresso por assento;
- trigger controlado no segundo ingresso comprovando rollback sem `Payment`, `PAID` ou ticket parcial;
- smoke HTTP de aprovação, recusa, listagem/detalhe, QR, mapa, rotação, revogação e página pública sem PII; fixtures removidas ao final;
- `git diff --check` e revisão de secrets/headers/logging no fechamento.

Não houve validação visual humana. O executável `agent-browser` não estava disponível e o navegador integrado recusou um módulo interno por política de caminho confiável; a interface foi verificada por lint, typecheck, build, respostas HTTP e revisão estática, sem atribuir inspeção visual inexistente.

## M5 — Portaria, câmera e consumo atômico

Em 18 de agosto de 2026, o Codex auxiliou na implementação da jornada operacional da portaria. O trabalho reutilizou o QR HS256 e o modelo `Ticket` do M4, sem criar entidade ou estratégia criptográfica nova. A API passou a listar sessões publicadas para `GATE`, resolver QR ou código manual e consumir com um único `UPDATE` condicional no PostgreSQL, preenchendo `usedAt` pelo relógio do banco e `usedByGateId` pela identidade autenticada.

A precedência `INVALID -> WRONG_EVENT -> ALREADY_USED -> VALID` foi explicitada para que a sessão escolhida seja a autoridade e para não revelar o uso de ingresso pertencente a outra sessão. O teste concorrente adotou a barreira PostgreSQL já usada nos milestones anteriores: duas requisições são comprovadamente bloqueadas na mesma linha antes da liberação, em vez de depender apenas do agendamento de `Promise.all`.

No frontend, a área temporária `GATE` foi substituída por seleção de sessão, scanner de câmera, entrada manual, quatro respostas inequívocas e reset operacional. `@zxing/browser@0.1.5` foi a única dependência direta adicionada; ela é carregada dinamicamente apenas na portaria, para decodificar QR sobre `getUserMedia`. O scanner interrompe a captura antes da chamada à API e trata permissão negada, ausência ou indisponibilidade de câmera mantendo o código manual acessível.

O seed foi ajustado para restaurar o ingresso demo para `VALID` ao ser executado novamente, preservando dados relativos e sem consultar a TMDb. A verificação final executou lint e typecheck dos dois workspaces, 111 testes, builds da API e do frontend, `git diff --check`, teste concorrente repetido com barreira real e smoke HTTP dos quatro resultados e da autorização. O navegador integrado não pôde ser inicializado por uma restrição de caminho confiável; portanto, não foi atribuída validação visual ou física da câmera, que ainda exige teste em dispositivo real servido por HTTPS ou em `localhost`.

## M6 — UX, robustez visual e redesign SEPTEM

Em 19 de agosto de 2026, o Codex auxiliou na auditoria e na refatoração visual do frontend, incluindo aplicação da identidade `SEPTEM`, reorganização das jornadas, estados de interface, responsividade e fallback para imagens indisponíveis. O apoio também incluiu a correção do pôster seedado de Interestelar e a atualização da documentação associada ao redesign.

A direção do produto não foi delegada à IA. Executei e validei manualmente o fluxo ponta a ponta antes deste milestone, critiquei a primeira versão por sua aparência editorial/genérica e por sua baixa densidade de informação, rejeitei essa direção e defini marca, prioridades e critérios de aceitação. A decisão humana foi destacar programação, pôsteres, sessão, assentos, compra e ingresso, além de preservar no Gate uma linguagem operacional distinta.

Contratos e regras de negócio existentes permaneceram fora do escopo do redesign. No fechamento, foram executados lint, typecheck, os 111 testes existentes, builds de API/web, `git diff --check` e auditoria de arquivos de ambiente, secrets e chave TMDb no frontend. O script raiz de desenvolvimento iniciou web e API, confirmadas por respostas HTTP em `/` e `/health`.

Não houve inspeção renderizada automatizada: o navegador integrado recusou um módulo interno por sua política de caminho confiável. Os breakpoints de 375, 768 e 1280 px foram revisados estaticamente, sem atribuir uma validação visual que não ocorreu; a aceitação visual é minha, antes de qualquer commit.

### Revisão V2 da experiência consumer

Em 19 de agosto de 2026, a IA auxiliou a implementar a segunda revisão da Home, do header público, do topo da sessão e do mapa de assentos. Avaliei manualmente tanto a primeira direção quanto o M6 v1 e rejeitei a Home do M6 v1 apesar de ela estar tecnicamente correta e visualmente mais consistente. A pesquisa de referências, a crítica ao modelo baseado em cards de sessão e a direção `local → data → filme → horário → assento` foram decisões humanas.

A implementação reaproveitou os dados e componentes existentes, sem biblioteca visual, componente externo, contrato novo ou mudança de backend. A V2 foi validada visualmente por mim antes de ser aceita; não houve Figma nem participação de designer profissional declarada.

### Revisão V3 da linguagem visual consumer

Em 19 de agosto de 2026, a IA implementou a V3 sob minha direção. Eu já havia rejeitado o M6 v1 e, mesmo após a melhora funcional da V2, rejeitei também sua linguagem visual por ainda parecer próxima demais da primeira solução. A crítica ao excesso de preto, retângulos, bordas e baixa presença dos filmes, assim como a decisão de combinar stage cinematográfico, rail de pôsteres e programação marfim, foram humanas.

Referências externas de redes de cinema e galerias foram estudadas manualmente para extrair princípios de hierarquia e atmosfera; nenhuma interface ou componente foi copiado. A implementação permaneceu em React e CSS existentes, sem dependência nova. A aceitação visual final é minha, após revisão manual; não houve Figma nem trabalho de designer profissional declarado.

## M7 — Swagger / OpenAPI

Em 19 de agosto de 2026, o Codex auxiliou no inventário das rotas e na implementação da documentação OpenAPI da API SEPTEM. O trabalho adicionou os plugins oficiais do Fastify, documentou as 23 operações reais e seus DTOs públicos, configurou autenticação bearer na Swagger UI e criou testes direcionados para inventário, segurança e resultados do Gate.

A decisão de executar apenas o bloco Swagger/OpenAPI, preservar Zod como autoridade de validação em runtime e não iniciar CI ou deploy foi decisão minha. Os schemas documentais foram conectados por transformação exclusiva do Swagger para evitar mudanças acidentais nos contratos, nas mensagens de erro ou na serialização dos handlers existentes. A aceitação final é minha, depois de revisar o diff e a experiência em `/docs`.

## M7 — GitHub Actions / CI

Em 19 de agosto de 2026, o Codex auxiliou na auditoria dos scripts, variáveis de ambiente e dependências reais da suíte e na implementação da CI do SEPTEM. O workflow usa somente actions oficiais, Node.js 22 e PostgreSQL 17 real, gera o Prisma Client, aplica as migrations em banco vazio e torna lint, typecheck, testes e build gates obrigatórios. A auditoria identificou que as contas demo são fixtures exigidas pelos testes; por isso o seed idempotente roda depois das migrations e sem consultar a TMDb.

Mantive o escopo restrito à CI e proibi deploy, serviços adicionais, mudanças funcionais, commit e push. A revisão confirmou a sintaxe e a estrutura do YAML, permissão somente de leitura, valores artificiais, ausência de token TMDb e compatibilidade com Linux. Localmente, lint e typecheck passaram nos dois workspaces, os 114 testes passaram e os builds da API e do frontend concluíram; permaneceu apenas o warning já conhecido de chunk do frontend acima de 500 kB.

## M7 — Preparação de deploy

Em 19 de agosto de 2026, o Codex auxiliou na auditoria técnica e na preparação mínima do repositório para Vercel e Railway, sem realizar deploy ou criar recursos externos. O trabalho adaptou a porta da API à variável fornecida pela plataforma, adicionou encerramento controlado do Fastify, registrou build, migrations, start e healthcheck do Railway e incluiu somente o rewrite necessário para as rotas da SPA na Vercel.

As decisões preservaram CORS por origem explícita, secrets apenas no backend, migrations automáticas com `prisma migrate deploy` e seed demonstrativo como operação única após o primeiro deploy. A validação local aprovou os arquivos de configuração, lint, typecheck, 114 testes e os builds da API e do frontend. Um smoke em modo produção confirmou a precedência de `PORT`, `/health`, `/docs` e `/docs/json`; outro build confirmou a injeção de uma `VITE_API_URL` pública fictícia sem nomes de variáveis privadas no bundle. Permaneceu apenas o warning conhecido de chunk acima de 500 kB.

## M7 — Polimento final de produto e UX

Em 19 de agosto de 2026, defini uma passada V3.5 sobre a direção SEPTEM já aprovada, com prioridade para acabamento perceptível, mobile, acessibilidade e visibilidade das regras fortes do produto. O 21st.dev foi usado como referência visual, e o ChatGPT auxiliou na curadoria e avaliação dessas referências. O Codex leu o repositório e o desafio versionado, auditou os fluxos e auxiliou na implementação e revisão.

Não houve copy/paste cego dos componentes estudados. O componente externo de ingresso oferecia boas ideias de boarding pass, notches, perfuração e hierarquia, mas sua camada de WebGL e dithering foi rejeitada por aumentar runtime, bundle e complexidade sem melhorar a leitura do QR. O sign-in externo dependia de Next.js, Three, Framer Motion e Tailwind CSS; essa composição também foi rejeitada por contrariar a stack e o nível de complexidade intencional do projeto. Os princípios aproveitados foram reimplementados com React, SVG e CSS próprios.

A implementação assistida incluiu marca SVG e metadata, estados globais de feedback e offline, preservação do contexto da programação, filtro derivado de cinemas reais, polling abortável de assentos, booking mobile, refinamento do timer sob autoridade do backend, compartilhamento por Web Share com fallback, melhorias de login, Organizer e Gate e uma passada de acessibilidade e responsividade. Nenhuma dependência foi adicionada; naquela primeira iteração, contratos, schema, regras de negócio, infraestrutura e deploy permaneceram fora do escopo.

Essa seleção privilegia APIs do navegador, componentes pequenos e comportamento explicável sobre uma troca de stack ou uma coleção de efeitos. Escopo, direção visual, itens proibidos e aceitação final foram decisões minhas. A automação do navegador integrado não iniciou por uma restrição interna de caminho confiável; por isso, a revisão no ambiente do Codex foi estática e nenhuma inspeção renderizada foi atribuída como realizada. A revisão visual final continua sendo humana antes de commit ou publicação.

A validação daquela iteração aprovou lint e typecheck nos dois workspaces, os 114 testes então existentes, builds da API e do frontend, `npm ls --depth=0` e `git diff --check`, sem dependência ou secret novo. Um smoke HTTP do build local confirmou a entrega da Home, login, favicon e deep links de sessão, reserva, ingressos, compartilhamento e Gate; ele não substitui a inspeção visual nem o teste físico de câmera/QR.

### Passada final após revisão humana

Em 19 de agosto de 2026, realizei nova revisão visual da aplicação publicada e aprovei a direção da marca, login, mapa, Organizer e Gate, mas rejeitei o acabamento ainda conservador da Home, o recorte inconsistente de alguns pôsteres e a altura do ingresso. Esse feedback humano definiu as prioridades da última passada; a IA não decidiu sozinha que o produto precisava de outro redesign.

O desafio oficial permaneceu como fonte primária. O ChatGPT apoiou a pesquisa e a curadoria de referências: a Ingresso.com ajudou a confirmar horário como ação central do fluxo de cinema; a Sympla serviu como referência de operação móvel da portaria; projetos públicos de Patrick Pierre e Kauã Miguel foram tratados apenas como benchmarks históricos de apresentação, pois pertencem a enunciados possivelmente diferentes; e o 21st.dev continuou sendo inspiração de princípios visuais. Nenhuma empresa ou candidato endossou a SEPTEM, e nenhum markup, CSS, asset, arquitetura ou texto dessas fontes foi copiado.

O Codex auxiliou na auditoria e implementação. A Home passou a usar campos já persistidos para backdrop, duração e agrupamento por TMDb, ganhou horários reais no stage, rail navegável e contexto reproduzível na URL. O seed recebeu um cenário mais denso e idempotente sem consultar a TMDb. Web Share, Clipboard, Blob/iCalendar e impressão do navegador foram escolhidos para compartilhar sessão, adicionar à agenda e salvar o ingresso sem biblioteca. O trabalho também corrigiu a proporção dos pôsteres e refinou Organizer e Gate sem alterar suas regras.

Foram descartados conscientemente WebGL, shaders, Framer Motion, biblioteca de carrossel, PDF por dependência, fetch da TMDb no frontend, WebSocket/SSE, trailer, favoritos e dados promocionais inventados. Cancelamento de compra paga também foi rejeitado após auditoria: devolver o assento preservando ticket e histórico exigiria remodelar a alocação, adicionar estados e testar novas corridas com a portaria, colocando em risco garantias já estabilizadas.

Esse descarte registra a decisão vigente naquela passada. Em 20 de agosto de 2026, uma nova revisão humana tornou o cancelamento da compra inteira uma prioridade explícita e autorizou a remodelagem auditável descrita na etapa seguinte; o registro anterior foi preservado, não apagado retrospectivamente.

A implementação permaneceu no working tree para revisão humana, sem commit, push, deploy ou acesso à produção. A validação renderizada automatizada continuou indisponível porque o navegador integrado recusou seu próprio módulo por política de caminho confiável; portanto, nenhuma inspeção visual automatizada foi atribuída como realizada.

Na validação técnica desta passada, `prisma generate`, lint, typecheck e os builds dos dois workspaces concluíram; 116 testes passaram e `npm ls --depth=0` confirmou o mesmo conjunto de dependências. O seed foi executado duas vezes somente no PostgreSQL local e preservou o cenário determinístico. Um smoke HTTP local confirmou health, OpenAPI, os três papéis de login, as oito sessões publicadas definidas pelo seed e o fallback da SPA em deep links. A câmera, o QR em dispositivo físico e a composição visual renderizada continuam reservados à revisão humana.

## M8 — Cancelamento auditável da compra

Em 20 de agosto de 2026, defini como P0 o cancelamento da compra paga inteira, com devolução imediata dos assentos, preservação do histórico e segurança na corrida com a portaria. O Codex auxiliou primeiro na auditoria de `ReservationSeat`, FKs, índices, queries de ocupação e ordens de lock; depois apoiou a implementação das migrations, serviço transacional, contrato OpenAPI, estados de ingresso, compartilhamento, Gate, frontend e testes de integração. A decisão de produto, as restrições e a autorização de implementação permaneceram humanas.

A remodelagem substituiu a unicidade global por `releasedAt` e um índice único parcial, mantido exclusivamente na migration SQL, para alocações ativas. Na revisão, foi rejeitado representar esse índice como `@@unique` no Prisma 7.9.1 porque o Client passava a oferecer `findUnique({ seatId })` sem carregar o predicado e poderia escolher uma linha histórica; o código preserva filtros explícitos `releasedAt: null`. Pagamento aprovado, ingresso e vínculo de assento não são apagados; o cancelamento move a reserva e seus ingressos para `CANCELLED`, neutraliza as credenciais nas respostas e mantém QR/código antigos inválidos no Gate. A ordem `Seat -> Reservation -> ReservationSeat -> Ticket` e updates condicionais coordenam cancelamento, nova reserva e consumo concorrente sem depender de estado em memória.

A suíte recebeu cenários de compra futura, retorno ao estoque, nova reserva pelo segundo cliente, ownership, sessão iniciada, ingresso usado, segundo cancelamento, link compartilhado, credenciais canceladas e corrida Gate × cancelamento. O seed foi mantido idempotente sem reativar uma alocação já liberada. O trabalho permaneceu no working tree, sem commit, push, deploy, acesso à produção ou novo secret.

## M9 — Handoff de sessão e cancelamento individual por ingresso (P0.1B)

Em 20 de agosto de 2026, retomei o trabalho não commitado do M8 em uma nova sessão do Claude Code (Sonnet 5, Anthropic), pedindo primeiro apenas um relatório de compreensão do estado local — sem qualquer alteração — cobrindo `git status`/diff, migrations pendentes, estrutura dos testes e possíveis inconsistências. O relatório identificou uma regressão de copy no resumo de checkout (pagamento recusado exibido como "Reserva cancelada") e registrou como abertas as mudanças amplas de `styles.css` fora do escopo do M8. Só depois de revisar esse relatório autorizei a continuação, em etapas controladas e sem commit/push/deploy automáticos.

Decidi então, por mensagem explícita: a regressão de copy deveria ser corrigida; as mudanças de `styles.css` eram intencionais e vieram de uma auditoria visual anterior, devendo ser preservadas integralmente; e a suíte oficial deveria ser revalidada do zero, incluindo um teste real e não hipotético do comando de seed documentado, antes de qualquer novo código. Também defini o escopo funcional do cancelamento individual — endpoint, regras, modelo de estado sem novo enum, política de concorrência com o Gate e com novas reservas, e a lista de cenários que a suíte deveria cobrir — e reservou a etapa seguinte (P0.2, tempo real) para depois de uma nova revisão humana.

O Claude Code aplicou exatamente essa direção: reverteu a copy do estado de pagamento recusado ao texto original; não tocou em nenhuma linha de `styles.css`; e validou `prisma validate`/`generate`, `lint`, `typecheck`, `test`, `build`, `git diff --check` e `npm ls --depth=0` sobre o estado herdado antes de escrever qualquer linha nova. O ambiente disponível só tinha Node.js 24.19.0 instalado (sem Node 22 para comparação); o comando oficial `npm run db:seed` (`prisma db seed` → `tsx prisma/seed.ts`, sem preload ou variável de ambiente adicional) foi executado três vezes seguidas nesse Node, sempre com sucesso e sem o erro `uv_os_get_passwd ENOMEM` que eu havia relatado antes; não foi possível reproduzir a falha nem confirmá-la como resolvida, e nenhum workaround foi adicionado.

A implementação do P0.1B acrescentou `POST /me/tickets/:id/cancel`, reaproveitando o schema existente sem nova migration: `ReservationSeat.releasedAt` e `TicketStatus.CANCELLED` já suportavam cancelamento por assento individual. O novo serviço bloqueia `Seat -> Reservation -> ReservationSeat -> Ticket` restrito ao único ingresso alvo, revalida ownership, status `VALID`, sessão futura e consistência da reserva, e decide se a `Reservation` fecha para `CANCELLED` contando dentro da própria transação quantos `Ticket` ainda `VALID` restam — sem persistir nenhum estado "parcialmente cancelado". `POST /reservations/:id/cancel` (M8) foi ajustado para conviver com ingressos já cancelados individualmente, cancelando somente os que ainda estão `VALID`. O frontend ganhou a ação discreta "Cancelar ingresso" no detalhe de um ingresso `VALID`, mantendo "Cancelar compra inteira" apenas no agrupamento por compra, sem duplicar a ação por ingresso.

A suíte nova cobriu cancelamento isolado sem afetar o ingresso irmão, devolução do assento ao mapa e a um segundo cliente, invalidação de QR/código antigos e da página compartilhada, RBAC/ownership/UUID, sessão iniciada, ingresso `USED`, duplo cancelamento, fechamento da reserva ao cancelar o último ingresso `VALID`, cancelamento integral sobre uma compra já parcialmente cancelada, corrida Gate × cancelamento individual nas duas ordens (com barreira real de lock, sem sleeps) e rollback controlado por trigger. `npm run check` completo — lint, typecheck, 140 testes (127 preexistentes intactos + 13 novos), builds da API e do frontend, `git diff --check` e `npm ls --depth=0` sem dependência nova — foi executado ao final, com a suíte repetida três vezes para descartar flakiness nos testes de concorrência. Documentação (`README.md`, `ARCHITECTURE.md`, `DECISIONS.md` com a ADR-020, `REQUIREMENTS.md`) foi atualizada para refletir o novo endpoint e a semântica revisada do cancelamento integral. Não houve inspeção visual renderizada do "Cancelar ingresso" nem do fluxo de checkout corrigido; a aceitação final é minha. O trabalho permaneceu no working tree, sem commit, push, deploy ou acesso à produção, e P0.2 (tempo real) não foi iniciado, aguardando a revisão humana desta etapa.

## M10 — Mapa de assentos em tempo real (P0.2)

Em 20 de agosto de 2026, após aprovar P0.1 e P0.1B em E2E manual no navegador, autorizei exclusivamente a etapa de tempo real e defini a arquitetura: PostgreSQL como fonte de verdade, SSE como sinal de invalidação e `GET /sessions/:id/seats` como snapshot autoritativo — uma mensagem SSE jamais podendo carregar ou definir o estado dos assentos. Também definiu as proibições (sem Redis, WebSocket, fila, broker ou dependência pesada), a manutenção do polling como rede de segurança, a lista de mudanças que devem sinalizar `seats-changed` e o cenário de demonstração com dois clientes.

O Claude Code implementou `GET /sessions/:id/events`, um broadcaster em memória por `sessionId` e a publicação pós-commit nos seis pontos que realmente alteram disponibilidade. Durante a verificação empírica do stream, dois achados corrigiram o desenho: o hook `onClose` do Fastify roda somente depois das requisições em voo, então `app.close()` ficava preso em um stream SSE — a limpeza foi movida para `preClose`; e o refresh do frontend descartava invalidações recebidas durante um fetch em andamento, o que foi substituído por single-flight com refresh encadeado e teto contra laço infinito. O indicador de UI ficou restrito a um rótulo textual discreto, sem ícone, animação ou redesenho, e o `styles.css` recebeu apenas o bloco estritamente necessário.

A suíte ganhou 14 testes de comportamento executados contra um servidor real em porta efêmera, lendo o stream de verdade em vez de usar `app.inject()`: abertura e headers, `sync` inicial, invalidação vista por um segundo cliente após hold, aprovação, recusa, cancelamento individual, cancelamento integral, isolamento entre sessões, ausência de evento após rollback provocado por trigger, remoção do assinante na desconexão, `app.close()` sem travar, recuperação por reconexão, expiração de hold decidida pelo banco e fallback de polling sem nenhum stream aberto. Nenhum teste usa sleep para sincronizar lógica: eles esperam o evento real, com timeout apenas como proteção — exceto onde é preciso provar a ausência de um evento. O arquivo de tempo real foi executado seis vezes seguidas sem flakiness.

A decisão por SSE em vez de WebSocket, a limitação do broadcaster em memória em múltiplas réplicas e a evolução possível para `LISTEN/NOTIFY` — deliberadamente não implementada — estão registradas na ADR-021. A aceitação final do comportamento em duas janelas reais é minha; nenhuma inspeção visual renderizada foi atribuída. O trabalho permaneceu no working tree, sem commit, push, deploy, dependência nova ou secret novo.

## M11 — Edição segura, painel operacional e duplicação (P1.1, P1.2, P1.3)

Em 20 de agosto de 2026, depois de aprovar P0.1, P0.1B e P0.2 em E2E manual, autorizei as três melhorias P1 em uma única rodada, exigindo implementação sequencial com validação entre etapas. Defini as regras de negócio: quais estados bloqueiam a edição de uma sessão publicada e quais não podem bloquear para sempre, a proibição explícita de usar `EXISTS Reservation` como política, a exigência de que o backend derive o motivo real, as definições exatas das métricas e a distinção entre receita simulada vigente e histórico financeiro, além da lista do que nunca pode ser copiado numa duplicação.

Antes de escrever qualquer código, o Claude Code auditou a disciplina global de locks e confirmou no código real que nenhum fluxo existente trava a linha de `Session` — todos os `JOIN "Session"` usam `FOR UPDATE OF <outra tabela>`. Isso permitiu prefixar `Session` à ordem global (`FOR SHARE` na reserva, `FOR UPDATE` na edição) sem inverter lock algum com pagamento, portaria ou cancelamentos, confirmando a direção que eu havia considerado.

Três achados corrigiram o desenho durante a implementação. Um rascunho com data no passado ficaria bloqueado pela regra de sessão iniciada, quebrando o fluxo legítimo de corrigir a data antes de publicar: a condição passou a valer apenas para sessões publicadas. A validação de data futura rodava antes da checagem de editabilidade e devolvia um 400 genérico onde o motivo real era `SESSION_STARTED`; a precedência foi invertida. E a reconstrução do layout esbarraria na FK `RESTRICT` de `ReservationSeat` para qualquer alocação histórica, mesmo já liberada — em vez de apagar histórico, o campo `layoutEditable` passou a expor essa restrição separadamente, mantendo os demais campos editáveis. O teste antigo que afirmava a imutabilidade absoluta de `PUBLISHED` foi reescrito, não removido, já que a regra que ele protegia foi deliberadamente substituída.

As métricas usam subconsultas independentes sobre `ReservationSeat` em uma única consulta agregada, com versão em lote na listagem, justamente para não multiplicar contagens e receita por produto cartesiano — um teste cobre esse cenário com duas compras distintas mais um hold na mesma sessão. A duplicação reaproveita o snapshot local e não chama a TMDb novamente, o que um teste verifica contando as chamadas ao catálogo.

A suíte cresceu com 30 testes novos nas três etapas, cobrindo política de editabilidade por motivo, ingressos `USED` e `CANCELLED` como bloqueio, histórico liberado que não bloqueia, edição de cada campo, rebuild de layout sem órfãos, ownership, rollback por trigger provocado, as duas ordens da corrida reserva × edição com barreira real de lock, cada definição de métrica, e o isolamento transacional da cópia. A identidade visual foi preservada: o `styles.css` recebeu apenas a extensão de seletores já existentes e um bloco compacto para o painel. Nenhuma dependência foi adicionada. O trabalho permaneceu no working tree, sem commit, push, deploy ou secret novo, e a aceitação visual final é minha.

## M12 — Base demo final

Em 20 de agosto de 2026, com o desenvolvimento funcional já aprovado em E2E manual, retomei o working tree não commitado e restringi o escopo a uma única tarefa: finalizar e revisar a base demo. Defini o alvo — quatro contas, doze a dezesseis sessões publicadas, quatro a seis filmes, horários plausíveis de cinema em vez de horas cheias, datas futuras calculadas de forma robusta, um ou dois rascunhos, uma sessão publicada limpa e editável, uma sessão com histórico comercial mínimo para demonstrar bloqueio e métricas, contas de cliente visualmente limpas e no máximo um ingresso `VALID` — e as proibições: nada de acúmulo artificial de `CANCELLED`/`USED`, nada de cinquenta sessões, nada de analytics inventado, nenhuma feature nova, nenhuma migration sem necessidade, nenhum redesenho de interface e nenhum commit, push ou deploy.

A revisão do estado herdado mostrou que a rodada anterior havia mexido no seed por outro motivo: torná-lo idempotente diante de alocações liberadas, deixando de reativar reserva e ingresso quando `ReservationSeat.releasedAt` já estava preenchido. Esse trabalho estava correto e foi preservado. A densidade da programação, porém, continuava a de M7 — oito sessões publicadas de três filmes em duas datas, com horários concentrados em `:00` e `:30`.

A base demo passou a ter catorze sessões publicadas e dois rascunhos, com cinco filmes, dois cinemas e quatro salas. Sala virou um registro com local, endereço e layout, de modo que o mesmo espaço não possa aparecer com capacidades diferentes em horários distintos. Os snapshots dos dois filmes novos — **Duna: Parte Dois** e **Cidade de Deus** — foram obtidos uma única vez da própria TMDb, com o token já configurado do projeto, e persistidos como constantes locais: o seed continua sem chamar a TMDb em tempo de execução. Os snapshots já aprovados dos três filmes anteriores não foram tocados.

Todos os identificadores de sessão anteriores foram reaproveitados pela nova grade em vez de substituídos. Como o seed é exclusivamente `upsert` mais `createMany` com `skipDuplicates` e nunca apaga, um banco já semeado converge para a base nova sem deixar sessões órfãs. Os layouts das sessões reaproveitadas foram mantidos exatamente como estavam, o que evita conflito com a FK `RESTRICT` de `ReservationSeat`.

O volume transacional foi mantido no mínimo: exatamente uma sessão — Matrix às 15:40 — carrega compra paga, pagamento aprovado e um único ingresso `VALID`. Ela sustenta ao mesmo tempo o `COMMERCIAL_HISTORY` da edição segura, a receita simulada vigente do painel e o roteiro completo da portaria; nenhuma outra sessão nasce com reserva, pagamento ou ingresso.

O teste do seed foi ampliado em vez de afrouxado. Além das contagens, dos identificadores e do ingresso demo, ele passou a exigir que `publishedAt` acompanhe o status, que os minutos dos horários publicados variem — provando que a grade não é uma sequência de horas cheias —, que nenhuma sala exiba dois filmes ao mesmo tempo — considerando a duração do filme mais um intervalo de limpeza — e que a compra de demonstração continue com exatamente um assento e um ingresso. Uma asserção mais forte, exigindo que nenhuma outra sessão demo tivesse ingresso, foi escrita e descartada na validação: o seed nunca apaga, então ela afirmaria algo que o seed não controla e quebraria em qualquer banco com E2E manual acumulado. O cálculo de datas foi exercitado à parte contra viradas de mês, de ano, ano bissexto e o caso em que o dia local de São Paulo difere do dia UTC.

A validação foi feita contra o PostgreSQL local. O comando oficial `npm run db:seed` foi executado duas vezes seguidas e a segunda execução produziu um snapshot idêntico ao da primeira — mesmos identificadores, mesmas contagens, mesmo código manual do ingresso demo e nenhuma linha duplicada. `npm run lint`, `npm run typecheck`, `npm run build` e `git diff --check` concluíram limpos, e a suíte manteve 186 testes passando, o mesmo total do baseline anterior à preparação da base demo. A revisão do banco local, porém, registrou um fato que o seed não pode corrigir: além da base demo, ele carrega resíduo de E2E manual — uma sessão criada à mão fora do seed, dezenove reservas, dezenove pagamentos e vinte e um ingressos, entre eles cinco `USED` e três `CANCELLED`. Como o seed é aditivo por decisão de auditoria, limpar esse resíduo é uma operação destrutiva deliberada e ficou reservada para mim. O trabalho permaneceu no working tree, sem commit, push, deploy, dependência nova ou secret novo, e a revisão visual final é minha.

## M13 — Auditoria final de frontend

Em 21 de agosto de 2026, com a base demo aprovada, autorizei uma rodada exclusivamente de frontend: UX, acessibilidade, responsividade, consistência e apresentação, com permissão para corrigir defeitos concretos e proibição explícita de redesign, feature, dependência nova ou qualquer alteração de backend, schema ou contrato.

A auditoria foi feita no navegador integrado contra a base demo real, em 375, 768 e 1440 px. O painel do navegador não compõe quadros neste ambiente, então screenshot e clique de mouse ficaram indisponíveis; a inspeção usou a árvore de acessibilidade e medição direta do DOM — geometria, estilos computados, tamanhos de alvo, corpo de texto e transbordo horizontal — e a interação foi feita pelos próprios controles da página. Nenhuma composição renderizada foi avaliada, e nenhuma conclusão visual foi atribuída como verificada.

Quatro defeitos concretos foram corrigidos. No hero da Home a 375 px o pôster permanece ao lado do texto por decisão de composição, o que comprime a coluna de conteúdo a 217 px e derrubava o rótulo do CTA principal para 8,96 px em três linhas; como o `aria-label` do botão já carrega "escolher lugares", a largura mínima passou a exibir só o preço, em 11,2 px e uma linha. No editor do organizador, quando a sessão é editável mas o mapa não, dois textos da mesma tela se contradiziam — "nenhuma reserva ou ingresso depende desta estrutura" contra "os lugares já foram reservados alguma vez" —, e o aviso passou a reconhecer o histórico em vez de negá-lo. No resumo de checkout, uma reserva `CANCELLED` era sempre rotulada "Pagamento recusado", o que é falso quando o cliente cancelou uma compra já paga e volta à URL da reserva; como o payload da reserva não expõe o pagamento e o contrato não podia mudar, a afirmação de recusa passou a valer apenas quando a recusa aconteceu naquela sessão de uso. Em Meus ingressos, "Assentos" estava fixo no plural. Os campos de layout também passaram a apontar por `aria-describedby` para a explicação do motivo pelo qual estão travados.

Uma correção foi escrita e revertida. A barra fixa de reserva cobre os últimos ~70 px da página no fim do scroll da sessão em telas estreitas, deixando a atribuição da TMDb parcialmente oculta; a regra CSS escrita para compensar não passou a vigorar nas medições, mesmo com o seletor casando e a regra presente na folha servida, e não foi possível determinar a causa neste ambiente. Em vez de deixar CSS morto aparentando uma correção inexistente, a regra foi removida e o defeito ficou registrado como encontrado e não corrigido.

Vários pontos foram auditados e deliberadamente não alterados: o mapa de assentos expõe o estado de cada lugar no nome acessível, não só por cor; o resultado da portaria move o foco para um contêiner com `aria-labelledby`/`aria-describedby` e título em 46 px; o ingresso cancelado nunca renderiza QR ou código; a copy de pagamento recusado no fluxo normal está correta; e o rótulo de marca em 8,64 px, embora pequeno, é decoração aprovada e redundante com o logotipo visível. `npm run lint`, `npm run typecheck`, `npm run build` e `git diff --check` concluíram limpos e a suíte permaneceu em 186 testes, sem alteração de backend nesta rodada. O trabalho permaneceu no working tree, sem commit, push, deploy, dependência nova ou secret novo.

## M14 — Revisão autônoma final

Em 21 de agosto de 2026, transferi ownership técnico da rodada e pedi uma revisão do projeto inteiro com autonomia para alterar qualquer camada, inclusive reverter decisões anteriores. A única regra de julgamento era que toda mudança respondesse positivamente a pelo menos um critério de qualidade declarado, e que nada fosse alterado só para deixar marca.

A revisão começou pelo desafio original, lido integralmente a partir do PDF. As passadas anteriores vinham operando sobre resumos; a leitura direta confirmou requisitos já atendidos e expôs duas exigências que o resumo não carregava: versionar os artefatos de contexto produzidos com IA, e o peso explícito da documentação e do histórico de commits na nota. Extrair o texto exigiu escrever um leitor de PDF próprio, porque o arquivo usa fontes Type0 com CIDs — o texto só apareceu depois de reconstruir o mapa `ToUnicode` a partir dos CMaps embutidos.

A auditoria de segurança foi feita contra a API em execução, não por leitura. RBAC cruzado entre os três papéis, ownership de ingresso, PII na página compartilhada, `Cache-Control`, formato dos erros e cobertura do OpenAPI passaram todos. Dois vazios apareceram: `POST /auth/login` aceitava tentativas ilimitadas — doze senhas erradas responderam em 443 ms — e nenhuma resposta trazia cabeçalho de segurança. Ambos foram fechados sem dependência nova, com a decisão registrada na ADR-026.

O limite de login foi redesenhado durante a própria implementação. A primeira versão bloqueava por até quinze minutos, e a revisão do próprio código identificou que, atrás do proxy de uma plataforma, `request.ip` é idêntico para todos os clientes: a chave composta degradaria para "só e-mail" e qualquer pessoa poderia derrubar uma conta demo conhecida durante a avaliação. O bloqueio virou um cooldown de sessenta segundos contado a partir da última falha. Uma segunda passada de self-review encontrou um erro de documentação — o texto afirmava taxa sustentada de dez tentativas por minuto, quando a implementação real entrega cerca de uma — e a afirmação foi corrigida nos três lugares e travada por teste.

Os cabeçalhos de segurança foram registrados em `onRequest`, não em `onSend`, porque o stream SSE chama `reply.hijack()` e copia os cabeçalhos manualmente; hooks de `onSend` nunca rodam para respostas sequestradas e deixariam justamente o endpoint de conexão longa descoberto. Um teste cobre esse caso específico.

No frontend, o defeito que a rodada anterior registrou como encontrado e não corrigido foi resolvido: a barra fixa de reserva cobria os últimos setenta pixels da página em telas estreitas, deixando o rodapé e a atribuição obrigatória da TMDb permanentemente fora de alcance. A tentativa anterior usava `:has()` e não passava a vigorar no navegador de teste; a correção passou a usar um modificador explícito aplicado pela rota, verificado por medição — altura do documento de 1570 para 1647 px e rodapé inteiramente acima da barra.

A mudança de maior impacto não foi de código. O README, porta de entrada da avaliação, nunca linkava `DECISIONS.md`, `ARCHITECTURE.md`, `REQUIREMENTS.md` nem `AI-USAGE.md` — um avaliador com dezenas de projetos poderia nunca encontrar as vinte e cinco ADRs, que são o artefato que melhor mostra o raciocínio. Foram adicionados um índice de documentação logo após a introdução, uma seção de demonstração e uma seção de segurança descrevendo o que o projeto realmente garante. A seção de demonstração nasceu com uma afirmação errada — a de que não havia deploy — corrigida na estabilização seguinte com as URLs reais da Vercel e do Railway.

Duas mudanças foram consideradas e recusadas. Rotear a área do organizador por URL resolveria a ausência de deep link e de botão voltar, mas exige reescrever o roteador próprio e o guarda de alterações não salvas sem nenhuma cobertura de teste no frontend — risco alto para ganho médio, registrado como limitação conhecida. E introduzir `@fastify/rate-limit` e `helmet` foi descartado porque a configuração padrão de ambos não toma justamente as decisões que importavam aqui.

A suíte passou de 186 para 191 testes em 18 arquivos, sem nenhuma dependência nova, com o seed executado duas vezes produzindo estado idêntico. O trabalho permaneceu no working tree, sem commit, push ou deploy.

## M15 — Estabilização pós-revisão

Em 21 de agosto de 2026, restringi a rodada à revisão do que a passada autônoma havia introduzido e corrigi duas premissas factuais do relatório anterior: a SEPTEM já possui deploy — frontend na Vercel e API com PostgreSQL no Railway — e já possui histórico de commits por milestone, sendo o problema real apenas o volume de trabalho recente ainda não commitado. A afirmação "não publicado" no README e a formulação "alvo de publicação" no `ARCHITECTURE.md` foram corrigidas; nenhum arquivo afirmava ausência de histórico de commits, esse erro ficou restrito ao relatório em chat.

A revisão crítica do limite de login encontrou o defeito que eu havia antecipado. A chave era `e-mail + origem` e o bloqueio acontecia antes da conferência da senha, então a senha correta também era recusada durante o cooldown; como cada nova falha reiniciava o minuto, bastava uma tentativa errada por minuto para manter uma conta conhecida permanentemente indisponível. Com as credenciais de demonstração públicas, isso seria uma negação de serviço trivial contra a própria avaliação — o oposto do que a proteção deveria fazer.

A correção foi tirar a conta da chave. O limite passou a valer por origem, com limiar de vinte falhas em quinze minutos e cooldown de um minuto: um cliente abusivo limita apenas a si mesmo e nenhum bloqueio direcionado a conta continua possível. O escopo da proteção foi renomeado com honestidade — ela protege a CPU do servidor contra um cliente que dispara Argon2 em série, e não é uma defesa contra adivinhação das contas demo, que não têm segredo a proteger. Foi acrescentada a variável `TRUST_PROXY`, desligada por padrão, porque a chave só significa "cliente" quando `request.ip` é o endereço real; confiar em `X-Forwarded-For` sem proxy permitiria forjar a origem. A ADR-026 foi reescrita com o desenho anterior, o motivo do descarte e o preço aceito: um atacante distribuído por várias origens não é contido por este limite.

O smoke local cobriu login correto e incorreto, a rajada até o `429` com `Retry-After` coerente, a recuperação real após esperar o cooldown de sessenta segundos, catálogo, Swagger UI, stream SSE com os cabeçalhos de segurança presentes na resposta sequestrada, ingresso, link compartilhado sem PII e portaria em `WRONG_EVENT` e `INVALID`. O ingresso de demonstração foi preservado em `VALID`: nenhuma etapa do smoke o consumiu ou cancelou. A correção do rodapé foi confirmada como escopada — o modificador aparece apenas na rota que tem barra fixa, e Home e Meus ingressos continuam sem espaço extra.

O total de testes permaneceu em 191, em 18 arquivos: os quatro casos do modelo antigo foram substituídos por quatro do modelo novo, sem inflar a contagem. `prisma validate`, `prisma generate`, lint, typecheck, build, `git diff --check` e `npm ls --depth=0` concluíram limpos, sem dependência nova. O trabalho permaneceu no working tree, sem commit, push ou deploy.

## M16 — Hardening pós-entrega

Em 22 de agosto de 2026, depois de enviar o repositório e ainda dentro do prazo da etapa, executei uma passada de hardening no frontend. Diferente das rodadas anteriores, esta terminou em branch dedicada, pull request com CI verde e merge em `main` — não no working tree.

Usei o Claude Code (Anthropic) como executor e o Claude como interlocutor de revisão do plano, pedindo explicitamente que o plano fosse contestado antes de executado.

### O que motivou a rodada

Duas lacunas que eu já reconhecia na entrega. O workspace `apps/web` não tinha nenhum teste, enquanto o backend tinha 191 de integração. E o `SessionEditor.tsx` acumulava 1213 linhas com 15 `useState`, incluindo três booleanos de operação independentes que representavam oito combinações possíveis para quatro estados reais.

Defini as restrições antes de começar: não tocar em `apps/api`, não adicionar dependência de runtime, trabalhar em branch separada, e abortar a refatoração se ela ficasse vermelha — preservando apenas os testes, que são puramente aditivos.

### O que foi feito

**Infraestrutura de teste.** Vitest e Testing Library em `apps/web`, ambiente jsdom, com stub de `matchMedia` — que o jsdom não implementa e a portaria consome. Os arquivos de teste entraram no `include` do `tsconfig.app.json`, de modo que `tsc -b` também os verifica; isso pagou imediatamente, ao apontar um erro de tipo real em uma fixture minha. O `ci.yml` não precisou de alteração: o `npm run test` da raiz já usa `--workspaces --if-present`.

**Quinze testes de jornada.** Portaria (7), mapa de assentos (3), checkout (2) e editor (3), consultados por papel e texto acessível, apoiados nos `aria-*` que o projeto já usava. Os mocks ficaram na camada `src/api.ts` e no componente `QrScanner`, não em `fetch` global.

**Estado discriminado no editor.** `isSaving`, `isPublishing` e `isSelectingMovie` colapsados em um único `EditorAction`, com `isBusy` derivado como `action !== 'idle'` e produzindo exatamente o mesmo booleano de antes. O encerramento passou por `finishAction`, que só retorna a `idle` se a operação encerrada ainda for a corrente: um `setAction('idle')` direto derrubaria outra operação em voo. Hoje são equivalentes, porque as operações são mutuamente exclusivas; a versão guardada não depende disso continuar verdade.

**Hook `useSessionForm`.** Estado e validação do formulário extraídos, absorvendo três repetições que estavam espalhadas pelo componente. O editor caiu para 1130 linhas e 10 `useState`.

### O que a ferramenta contestou, e o que mudou por causa disso

Três objeções vieram com evidência no código, e duas alteraram a execução:

1. A refatoração atingiria o `SessionEditor`, que os testes planejados não cobriam — o critério "se ficar vermelho, reverta" não valeria para ele, porque `npm run check` verde não provaria nada sobre o arquivo refatorado. Aceitei e acrescentei três testes do editor, escritos contra comportamento observável para que sobrevivessem à refatoração. O do guarda de alterações não salvas usa a prop `onDirtyChange`, que é contrato público, não o estado interno.
2. `isDuplicating` está deliberadamente fora do `isBusy` que alimenta `onBusyChange`, e o código soma os dois manualmente onde importa. Colapsar os quatro flags mudaria silenciosamente o que o componente pai enxerga como ocupado. Cancelei essa parte do plano: `isDuplicating` permaneceu separado.
3. `matchMedia` não existe no jsdom e quebraria os testes da portaria na primeira renderização. Resolvido no setup.

### Uma premissa minha que estava errada

Dois testes que especifiquei para a portaria — validação de formato e normalização de hífen e espaço — partiam da suposição de que essa lógica existia no frontend. Não existe: o `GateArea` faz apenas `trim` e `toUpperCase`, e a normalização vive em `normalizeManualCode` (`gate.service.ts`), já coberta pelos testes da API. Escrevê-los como planejado significaria duplicar teste de backend ou afirmar comportamento inexistente. Foram reescritos para o que o componente de fato garante: o guarda de campo vazio e a preservação fiel do que o operador digitou.

### O que ficou deliberadamente de fora

Extrair carregamento e ações de servidor para um segundo hook, e quebrar o editor em componentes menores. São os caminhos de publicar e duplicar, que não têm cobertura automatizada; refatorá-los sem rede, dentro da janela de entrega, não se pagava. O corte foi decidido depois que a própria ferramenta apontou que a rede de testes alcançava salvar, bloqueio e dirty, mas não publicar nem duplicar.

Também considerei e recusei corrigir a janela em que os controles de edição permanecem habilitados durante uma duplicação. É uma lacuna pequena e real: `isDuplicating` fora do `isBusy` está certo quanto ao guarda de navegação, mas deixa passar cliques em "Salvar alterações" enquanto a duplicação está no ar. Na prática é inofensivo — são recursos distintos no servidor e a duplicação navega para fora ao terminar. Fica registrada, não corrigida: mudar comportamento de produto a dois dias do prazo não se justificava.

Publicar, duplicar e rebuild de layout seguem validados apenas manualmente.

### Validações desta etapa

- `npm run check` verde localmente: API 191/191 (intacta) e web 17/17, lint com `--max-warnings=0`, typecheck e builds dos dois workspaces.
- CI verde no pull request contra PostgreSQL 17 limpo, e novamente após o merge em `main`.
- Verificação manual no navegador dos seis caminhos do organizador, com atenção deliberada a publicar e duplicar, que não têm cobertura automatizada: sessão bloqueada exibindo o motivo real, edição e salvamento de uma publicada sem histórico, publicação de rascunho, duplicação gerando rascunho sem dados transacionais, troca de filme pelo catálogo e disparo do guarda ao sair com alteração pendente.
- Nenhum `any`, `@ts-ignore` ou `eslint-disable` foi introduzido, e nenhuma dependência de runtime foi adicionada.

Durante a rodada, o Docker Desktop do ambiente entrou em crash-loop por sockets órfãos, derrubando o PostgreSQL local e deixando 14 arquivos de teste da API vermelhos. O diagnóstico confirmou que a causa era ambiental e não a alteração; após `wsl --shutdown` e reinício, os 191 testes voltaram intactos. O episódio reforçou que o CI, com seu próprio PostgreSQL, é a rede de segurança confiável para a suíte de backend.

