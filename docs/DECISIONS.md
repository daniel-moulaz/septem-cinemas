# Decisões Técnicas

As decisões abaixo registram a evolução técnica do projeto. Adendos indicam políticas substituídas; mudanças relevantes devem manter este registro coerente com a implementação.

## ADR-001 — Cinema e TMDb

### Contexto

O domínio de cinema integra catálogo, programação, reserva e operação em uma jornada completa e coerente.

### Decisão

Implementar exclusivamente sessões de cinema. A TMDb será acessada pelo backend, e cada sessão guardará um snapshot do filme.

### Alternativas consideradas

Shows com Ticketmaster, suportar os dois domínios ou consultar a TMDb em toda exibição.

### Trade-offs

O foco reduz bifurcações e melhora a identidade do produto. Em contrapartida, dados operacionais de sessão, local, preço e assentos são responsabilidade da aplicação, e snapshots não acompanham correções posteriores da TMDb.

## ADR-002 — Monorepo e monólito modular

### Contexto

Frontend e backend precisam permanecer separados, mas o projeto deve ser simples de executar e avaliar.

### Decisão

Usar monorepo com `apps/web` em React/Vite e `apps/api` em Fastify, PostgreSQL e Prisma. O backend será um monólito modular por domínio. Não haverá `packages/` até existir reutilização concreta.

### Alternativas consideradas

Repositórios separados, microsserviços, Next.js, NestJS, FastAPI e um pacote compartilhado criado antecipadamente.

### Trade-offs

Scripts, CI e revisão ficam centralizados, com baixo custo operacional. Pode haver pequena duplicação de tipos entre cliente e API, preferível a uma abstração sem reutilização concreta.

## ADR-003 — Snapshot e imutabilidade após publicação

### Contexto

Alterar filme, horário, local, preço ou assentos depois da venda pode invalidar a decisão de compra e quebrar reservas ou ingressos.

### Decisão

Salvar os dados relevantes da TMDb na sessão. Permitir mudanças estruturais apenas em `DRAFT`; uma sessão `PUBLISHED` é estruturalmente imutável no MVP. Correções exigem novo rascunho.

### Alternativas consideradas

Consultar sempre a TMDb, editar até a primeira venda, permitir alterações parciais ou versionar sessões.

### Trade-offs

A regra protege invariantes e é fácil de explicar. Reduz flexibilidade do organizador; cancelamento e migração de compradores ficam fora do MVP e devem constar como limitação.

> **Adendo de 20/08/2026 — superseded:** a imutabilidade absoluta de `PUBLISHED` descrita acima foi substituída pela política de edição segura da ADR-022. Uma sessão publicada continua imutável enquanto existir consequência comercial, mas deixou de ser bloqueada apenas por ter sido publicada. O texto original permanece como registro da decisão vigente naquela etapa.

## ADR-004 — Hold de 10 minutos com garantia no PostgreSQL

### Contexto

Uma checagem de disponibilidade no frontend ou um `if` no backend não impede duas requisições concorrentes de obter o mesmo assento.

### Decisão

Criar hold de 10 minutos em transação. Bloquear primeiro os assentos por ID crescente e depois as reservas relacionadas por ID crescente. Usar `UNIQUE(ReservationSeat.seatId)` como árbitro final. Expirar e liberar holds de forma lazy, atômica e na mesma ordem de locks usada pelo pagamento, sem cron/job.

### Alternativas consideradas

Reserva definitiva antes do checkout, somente constraint sem locks coordenados, cron, Redis, fila ou controle no frontend.

### Trade-offs

Há correção com múltiplas instâncias da API e sem infraestrutura adicional. Será necessário SQL de lock pontual por meio do Prisma, e um hold vencido só é normalizado quando consultado, disputado ou pago.

> **Adendo de 20/08/2026:** a unicidade global e a exclusão descritas acima foram substituídas pela liberação auditável da ADR-018. O texto original permanece como registro da decisão vigente naquela etapa.

## ADR-005 — Pagamento simulado determinístico

### Contexto

Quem utiliza o projeto precisa reproduzir aprovação e recusa, sem integração financeira real.

### Decisão

O checkout oferece cenários explícitos `APPROVED` e `DECLINED`. O backend calcula o total. Aprovação, mudança da reserva e emissão dos ingressos ocorrem na mesma transação; recusa é registrada e libera o hold sem gerar ingresso.

### Alternativas consideradas

Sandbox de provedor real, resultado aleatório ou múltiplas tentativas na mesma reserva.

### Trade-offs

O fluxo é previsível, rápido de testar e suficiente para demonstrar regras de negócio. Não exercita webhooks nem falhas de um adquirente; nova tentativa começa por outra reserva.

## ADR-006 — QR HS256 e validação persistida

### Contexto

Um UUID ou código previsível no QR pode ser fabricado, e uma assinatura válida isoladamente não informa se o ingresso já foi usado.

### Decisão

Usar JWT/JWS HS256 com dados mínimos, segredo exclusivo em variável de ambiente, algoritmo fixado, emissor e audiência. Após validar a assinatura, consultar ticket, sessão e status no banco. Consumir com update condicional atômico.

A sessão escolhida pela portaria é a autoridade operacional. A precedência é `INVALID`, `WRONG_EVENT`, `ALREADY_USED` e, por fim, a tentativa de consumo `VALID`. Portanto, mesmo um ingresso já utilizado retorna `WRONG_EVENT` quando pertence a outra sessão, sem revelar seu estado de uso fora do contexto selecionado.

### Alternativas consideradas

ID puro, token próprio com HMAC e assinatura assimétrica.

### Trade-offs

HS256 é conhecido, pequeno e adequado a um único backend. Exige proteção e rotação operacional do segredo; rotação com múltiplas chaves não entra no MVP. O payload é legível e, por isso, não contém PII. A precedência reduz informação operacional exposta entre sessões, ao custo de não informar à portaria que o ingresso de outro evento já foi usado.

## ADR-007 — Compartilhamento por bearer link simples

### Contexto

Compartilhar precisa ser demonstrável sem expor a conta do cliente nem virar transferência ou revenda.

### Decisão

Gerar 32 bytes aleatórios para `/shared/:token`, armazenar somente `SHA-256(token)` e responder com `Cache-Control: no-store`. A página pública omite dados pessoais e pode exibir o ingresso e o QR enquanto o link e o ticket forem válidos.

### Alternativas consideradas

URL autenticada, ID do ticket, fragmento seguido de `POST /resolve`, ocultar o QR ou implementar transferência de titularidade.

### Trade-offs

O fluxo tem uma única URL e pouco código. Como todo bearer link, concede acesso a quem o possuir; hash, alta entropia, expiração/revogação e ausência de cache reduzem o risco, mas não impedem o destinatário de repassá-lo.

## ADR-008 — JWT, RBAC e ownership no backend

### Contexto

Proteger apenas páginas React permite chamadas diretas indevidas à API.

### Decisão

Usar senhas com Argon2id, JWT de autenticação e guards para `ORGANIZER`, `CUSTOMER` e `GATE`. Cada serviço também verifica ownership. O segredo de autenticação é separado do segredo dos ingressos.

### Alternativas consideradas

Sessão em servidor, autorização somente no frontend ou um único tipo de usuário.

### Trade-offs

JWT simplifica cliente e deploy, mas revogação imediata fica fora do MVP. A dupla verificação de papel e ownership adiciona código deliberado para evitar acesso horizontal.

## ADR-009 — Deploy como P0 estratégico

### Contexto

O deploy oferece acesso direto ao produto e exercita a integração entre navegador, API e banco.

### Decisão

Considerar a entrega pronta somente após publicar e executar smoke test do frontend, API e PostgreSQL. O alvo inicial é Vercel para web e Railway para API/banco; execução local documentada permanece como fallback.

A preparação usa configuração versionada mínima: rewrite da SPA no projeto Vercel e Railpack no Railway com build exclusivo da API, migrations em pre-deploy, start do workspace e healthcheck. O seed demonstrativo não faz parte do ciclo automático e deve ser executado uma vez após as migrations.

### Alternativas consideradas

Somente ambiente local, Render ou concentrar todos os serviços em uma plataforma.

### Trade-offs

Há valor na demonstração pública, ao custo de tempo com CORS, HTTPS, migrations, seed e variáveis de ambiente. Um bloqueio externo deve ser documentado, não escondido.

## ADR-010 — Escopo orientado às jornadas críticas

Priorizar reserva, pagamento simulado, emissão e portaria com testes e documentação. Integração financeira real, múltiplos domínios e infraestrutura distribuída dependem de necessidades concretas. Menor amplitude permite desenvolver as garantias transacionais; limitações estão em KNOWN-LIMITATIONS.md.

## ADR-011 — Identidade SEPTEM e linguagem por jornada

### Contexto

A primeira direção visual era funcional, porém excessivamente editorial e genérica. O teste manual conduzido pelo autor mostrou baixa densidade de produto: slogans, espaço vazio e títulos de exibição recebiam mais atenção que filmes, horários, salas e preços. A interface ficou visualmente desalinhada da profundidade já existente no backend.

### Decisão

Rejeitar essa direção e adotar a marca visível `SEPTEM`, referência à sétima arte. A programação passa a colocar pôsteres, dados da sessão, escolha de lugares e compra acima de hero ou slogans. Customer e Organizer compartilham uma identidade contemporânea de rede de cinemas; Gate mantém linguagem própria, operacional e orientada à leitura rápida dos quatro resultados.

### Alternativas consideradas

Polir apenas cores e espaçamentos da interface anterior, adotar um dashboard SaaS genérico ou aplicar a mesma linguagem promocional a todas as jornadas.

### Trade-offs

O redesign exige revisão transversal de componentes, estados e responsividade, mas não altera contratos nem regras de negócio. Separar visualmente o Gate reduz uniformidade entre áreas em favor de clareza operacional e segurança na portaria.

## ADR-012 — Programação consumer orientada por data, filme e horário

### Contexto

O M6 v1 melhorou a identidade SEPTEM e as telas críticas, mas a revisão humana concluiu que a Home ainda preservava o modelo mental da primeira solução: uma lista de cards independentes de sessões. Interfaces reais de bilheteria e redes de cinema foram estudadas para entender sua arquitetura de informação, sem copiar apresentação ou componentes.

### Decisão

Organizar a experiência consumer na sequência `contexto/local → data → filme → horário → assento`. Um filme real da programação abre a página; datas são derivadas das sessões existentes; sessões da data são agrupadas por filme, cinema e sala; e cada horário é a ação que leva à escolha de lugares. Referências externas serviram apenas à hierarquia da informação. Componentes prontos analisados foram deliberadamente rejeitados para evitar novas dependências e aparência de template.

### Alternativas consideradas

Manter os cards de sessão com novo acabamento, copiar padrões visuais de uma rede existente ou instalar carrossel e biblioteca de UI.

### Trade-offs

A transformação client-side permanece simples e não exige contrato novo, mas agrupa filmes por título e data de lançamento porque o resumo público não expõe `tmdbId`. Datas e horários seguem o fuso do navegador, coerente com o comportamento já existente.

## ADR-013 — Cinema marquee e sistema de superfícies consumer

### Contexto

A V2 corrigiu o modelo mental da Home, porém a revisão visual humana ainda a considerou próxima demais da primeira direção: quase toda preta, composta por retângulos e divisores, com pôsteres tratados como miniaturas. A organização estava correta, mas a linguagem ainda parecia um wireframe bem estilizado em vez de uma rede de cinema.

### Decisão

Adotar na Home o sistema `Cinema Black + SEPTEM Red + Ticket Ivory`. Um filme real ocupa um stage cinematográfico criado a partir de seu próprio pôster; um rail dá protagonismo aos filmes em cartaz; e datas, cinemas, salas e horários vivem em uma prancha marfim conectada visualmente ao ingresso. Hierarquia, superfícies, imagem e espaçamento substituem a maior parte das bordas. Interfaces reais foram pesquisadas como referência de princípios, nunca como templates ou layouts a copiar.

### Alternativas consideradas

Aplicar apenas escala, hover e cantos novos à V2, copiar a composição de uma rede existente ou instalar componentes de carrossel e bibliotecas de UI/animação.

### Trade-offs

Naquela iteração, o resumo público ainda não oferecia backdrop; por isso a atmosfera reutilizava o pôster com blur e gradientes. Essa limitação foi revista de forma aditiva na ADR-017. A superfície clara exige estilos de contraste cuidadosamente escopados, mas mantém dependências e arquitetura da informação intactas.

## ADR-014 — OpenAPI gerado sem duplicar validação

### Contexto

Quem utiliza o projeto precisa inspecionar e experimentar a API sem depender primeiro do frontend ou de conhecimento prévio das rotas. Ao mesmo tempo, os contratos já são validados com Zod e não devem ser reestruturados apenas para produzir documentação.

### Decisão

Usar os plugins oficiais `@fastify/swagger` e `@fastify/swagger-ui`, compatíveis com o Fastify 5, e publicar a interface em `/docs` e o documento em `/docs/json`. As 23 operações reais são organizadas por domínio, com bearer JWT declarado nas rotas protegidas e indicação concisa do papel exigido. A conversão dos schemas Zod é exclusiva da geração OpenAPI; a autorização e a validação em runtime permanecem no backend existente.

### Alternativas consideradas

Manter somente uma lista de endpoints no README, duplicar todos os contratos em JSON Schema ou introduzir outra biblioteca de validação e um type provider em toda a API.

### Trade-offs

A solução oferece documentação interativa com baixo impacto arquitetural e reaproveita os contratos de entrada existentes. Alguns schemas de resposta precisam ser descritos manualmente para representar os DTOs públicos, portanto devem permanecer sincronizados com os serviços; em compensação, evita-se uma refatoração ampla ou uma segunda validação em runtime.

## ADR-015 — CI com PostgreSQL real e banco vazio

### Contexto

As regras críticas dependem de transações, locks e constraints do PostgreSQL. A entrega também precisa demonstrar que um checkout limpo prepara o schema sem estado prévio ou serviços externos reais.

### Decisão

Executar a CI no GitHub Actions com Node.js 22 e PostgreSQL 17 como service container. Após a instalação reproduzível com `npm ci`, gerar o Prisma Client, aplicar `prisma migrate deploy` em banco vazio e carregar os dados de demonstração exigidos pela suíte. Lint, typecheck, testes e builds da API e do frontend são gates obrigatórios. Todas as credenciais são artificiais, e a fronteira da TMDb permanece simulada nos testes, sem GitHub Secrets.

### Alternativas consideradas

SQLite, banco mockado, `prisma db push`, banco compartilhado já preparado, chamada real à TMDb, múltiplos jobs ou matrizes de sistema operacional e versão do Node.

### Trade-offs

O banco real aumenta a confiança nas migrations e nas regras concorrentes, ao custo de uma execução mais lenta que testes isolados. Um job sequencial reduz duplicação e facilita o diagnóstico, mas não valida deploy nem disponibilidade da TMDb, que permanecem fora deste bloco.

## ADR-016 — Polimento final como evolução da V3, sem nova stack

### Contexto

A V3 já havia sido aceita como direção visual e o fluxo ponta a ponta estava publicado. A etapa final precisava tornar mais visíveis as qualidades reais do produto — concorrência de assentos, hold, ingresso e operação da portaria — sem reabrir o redesign, inventar dados ou transformar um projeto React júnior em uma vitrine de bibliotecas.

Componentes do 21st.dev foram avaliados apenas como referência. O ticket externo combinava uma boa composição de boarding pass com WebGL e dithering desproporcionais ao problema; o sign-in externo dependia de Next.js, Three, Framer Motion e Tailwind CSS, incompatíveis com a arquitetura e com o orçamento de bundle do projeto.

### Decisão

Manter a linguagem `Cinema Black + SEPTEM Red + Ticket Ivory` e executar uma revisão V3.5 com React, CSS e Web APIs nativas. A inspiração aproveitada do ticket se limita a corpo e canhoto, notches, perfuração e hierarquia editorial, reimplementados no código existente; nenhuma implementação externa foi copiada. A marca recebe símbolo SVG próprio, favicon e lockup, também sem asset gerado externamente.

O mapa consulta a disponibilidade a cada oito segundos somente enquanto a tela está ativa, com cancelamento, pausa em aba oculta e reconciliação da seleção. Isso torna o comportamento quase em tempo real perceptível sem WebSocket, Redis ou mudança no backend. O PostgreSQL e a API continuam autoridades sobre disponibilidade, expiração, pagamento e consumo. Feedback, compartilhamento nativo, fullscreen e háptica são progressivos e não criam dependências obrigatórias.

### Alternativas consideradas

Copiar os componentes estudados, instalar uma biblioteca de UI/animação/carrossel, reescrever em Next.js/Tailwind, usar WebSocket para assentos, redesenhar a V3 ou limitar a etapa a mudanças cosméticas.

### Trade-offs

HTML, CSS e estado local mantêm bundle, stack e explicabilidade sob controle, mas exigem mais cuidado manual com responsividade e acessibilidade. O polling adiciona uma requisição leve durante a seleção e não oferece atualização instantânea; em troca, possui ciclo de vida simples e reaproveita um endpoint idempotente. As melhorias progressivas dependem do suporte do navegador e sempre preservam o fallback funcional.

## ADR-017 — Passada final orientada por programação real e ações nativas

### Contexto

A revisão visual humana da V3.5 aprovou marca, login, mapa, Organizer e Gate, mas identificou três problemas ainda perceptíveis: pôsteres pequenos eram esticados pela altura variável dos cards, o topo da Home não aproveitava o backdrop já persistido e a programação semeada tinha pouca densidade para demonstrar o agrupamento por filme e horário. O ingresso também precisava ocupar menos altura e oferecer utilidades coerentes com um artefato real.

A [Ingresso.com](https://atendimento.ingresso.com/portal/pt-br/kb/articles/como-fa%C3%A7o-para-comprar-meu-ingresso-pelo-site) foi consultada como referência de hierarquia — horário inicia a compra e assentos vêm em seguida — e a [Sympla](https://produtores.sympla.com.br/funcionalidades/check-in-para-eventos/) como referência operacional de leitura móvel. Referências orientaram a hierarquia da informação; não autorizam copiar interface, código ou escopo.

### Decisão

Padronizar pôsteres em caixas 2:3, com dimensões intrínsecas e `srcset` limitado aos tamanhos da TMDb usados pelo produto. Expor no resumo público os campos já persistidos `tmdbId`, `backdropPath` e `runtimeMinutes`; a adição permite agrupar pelo identificador real, renderizar backdrop full bleed e apresentar vários horários reais sem N+1 ou chamada da TMDb no navegador.

Recompor a Home como stage de programação, não landing page: filme ativo, pôster completo, dados existentes e horários como CTAs, seguidos por um rail com foco, teclado, scroll-snap e profundidade discreta. Busca, data, cinema e filme ativo são preservados em `sessionStorage` e refletidos em `URLSearchParams` por `replaceState`, evitando criar uma entrada de histórico por interação no router manual.

Enriquecer o seed determinístico para oito sessões publicadas, três snapshots de filme, duas datas, dois cinemas e um rascunho, preservando as fixtures de ticket e portaria. Compartilhamento de sessão, arquivo iCalendar e impressão do ingresso usam Web Share, Clipboard, Blob e print CSS nativos. O QR, as regras do backend e o schema do banco não mudam.

> **Adendo de 20/08/2026 — superseded:** a densidade do seed descrita neste parágrafo foi substituída pela base demo final da ADR-025. O texto original permanece como registro da decisão vigente naquela etapa.

### Alternativas consideradas

Carrossel ou animação de terceiros, Framer Motion, WebGL, consulta da TMDb pela Home, WebSocket/SSE para assentos, dados promocionais inventados, trailer, favoritos e download de PDF por biblioteca. Também foi analisado cancelar uma compra paga e devolver o assento.

### Trade-offs

O resumo público fica ligeiramente maior e o seed prepara mais assentos, mas a Home evita requisições adicionais e passa a demonstrar o modelo de programação. `navigator.share`, Clipboard, download e impressão dependem do suporte do navegador, sempre com fallback funcional. A URL usa substituição de estado, não histórico granular de filtros, para manter o router simples.

Cancelamento de compra paga foi conscientemente descartado. A alocação vendida permanece em `ReservationSeat` com `seatId` único e é referenciada por `Ticket` via FK `RESTRICT`; liberar o lugar sem apagar o histórico exigiria desacoplar ou snapshotar o assento, criar novos estados e cobrir corridas entre cancelamento, nova compra e Gate. Preservar venda única e consumo atômico é mais importante que adicionar esse opcional na última passada.

> **Adendo de 20/08/2026 — superseded:** após nova decisão explícita de produto e uma auditoria específica de schema, FKs, índices e concorrência, o descarte do cancelamento foi substituído pela ADR-018. O parágrafo acima é mantido para não reescrever o histórico.

## ADR-018 — Cancelamento auditável da compra paga

### Contexto

O requisito de devolver imediatamente os assentos de uma compra cancelada conflita com o antigo `UNIQUE(ReservationSeat.seatId)`: excluir a alocação liberaria o estoque, mas quebraria o histórico referenciado por `Ticket`; mantê-la impediria uma nova reserva do mesmo assento. A solução também precisa ser correta quando Gate e cancelamento atuam sobre o mesmo ingresso.

### Decisão

Definir uma alocação como ativa somente quando `ReservationSeat.releasedAt IS NULL`. `TicketStatus.CANCELLED` entra em uma migration própria; a migration seguinte adiciona `releasedAt`, atualiza o check de uso do ingresso, cria primeiro o índice único parcial `ReservationSeat_active_seatId_key` em `seatId WHERE releasedAt IS NULL` e só então remove a unicidade global. Essa separação permite que o novo valor do enum seja confirmado antes de aparecer no novo check. Expiração, pagamento recusado e cancelamento preenchem `releasedAt` com o relógio do PostgreSQL; consultas de estoque, ocupação e conflito filtram explicitamente apenas alocações ativas.

O cliente cancela por `POST /reservations/:id/cancel` somente uma reserva `PAID` própria, inteira, antes do início da sessão e sem nenhum ingresso `USED`. A transação preserva o `Payment` aprovado sem simular refund, move todos os `Ticket` de `VALID` para `CANCELLED`, move a `Reservation` para `CANCELLED` e libera suas alocações. As respostas autenticada e compartilhada expõem `manualCode` e `qrToken` como `null` para ingresso cancelado; credenciais emitidas anteriormente resultam em `INVALID` no Gate.

A ordem de locks é `Seat -> Reservation -> ReservationSeat -> Ticket`, com coleções ordenadas. Se o Gate vencer a disputa, `VALID -> USED` ocorre primeiro e o cancelamento rejeita a compra. Se o cancelamento vencer, `VALID -> CANCELLED` ocorre primeiro, o update condicional do Gate não concede entrada e sua releitura produz `INVALID`.

### Alternativas consideradas

Excluir `ReservationSeat`, tornar `seatId` nulo e snapshotar o assento no ingresso, manter o assento indisponível depois do cancelamento, ou usar estado de estoque somente em memória.

### Trade-offs

O índice parcial fica exclusivamente na migration SQL e mantém a garantia no PostgreSQL em múltiplas instâncias. Ele não é representado como `@@unique` no schema: no Prisma 7.9.1, essa declaração faria o Client tratar `seatId` como identificador global em `findUnique`, embora o banco permita várias linhas históricas e somente uma ativa, podendo retornar uma linha liberada sem respeitar o predicado. O código usa `id` ou chave composta para unicidade e filtros explícitos `releasedAt: null` nas consultas ativas. Linhas históricas passam a se acumular e toda query de disponibilidade precisa declarar esse filtro; em troca, FKs, pagamentos, ingressos e links permanecem auditáveis sem permitir double booking. O código manual histórico continua persistido, porém não é mais exposto e o status persistido impede seu uso.

## ADR-019 — Política futura para edição segura de sessão publicada

> **Adendo de 20/08/2026 — implementada:** esta política deixou de ser futura. A regra efetivamente implementada, incluindo a disciplina de locks e o tratamento do layout, está na ADR-022. O texto abaixo é preservado como registro da decisão original.

**Status: FUTURA — NÃO IMPLEMENTADA.**

### Contexto

A imutabilidade absoluta de `PUBLISHED` protege compras, mas também bloqueia correções em sessões cujo histórico foi totalmente liberado e não produziu consequência comercial.

### Decisão futura

Uma sessão publicada poderá ser elegível para edição estrutural somente quando o backend provar, na mesma transação, que todo o histórico está liberado e não há consequência comercial. Bloqueiam a edição: hold ativo, qualquer reserva `PAID`, qualquer `Ticket` — inclusive `CANCELLED` —, sessão já iniciada e histórico transacional inconsistente. Se elegível, a sessão deverá permanecer `PUBLISHED`.

### Alternativas consideradas

Manter `PUBLISHED` sempre imutável, liberar qualquer edição sem considerar histórico ou decidir a elegibilidade apenas no frontend.

### Trade-offs

A política recupera flexibilidade sem reescrever compras, mas requer locks, revalidação de todo o histórico e testes concorrentes com reserva. Até essa implementação existir, o contrato real continua sendo edição apenas de `DRAFT`.

## ADR-020 — Cancelamento individual por ingresso

### Contexto

O P0.1 (ADR-018) só cancela a compra inteira. Uma compra com mais de um assento — por exemplo `B4` e `B5` — não permite desistir de um lugar isolado sem cancelar também os demais ingressos válidos da mesma reserva, mesmo quando somente um deles deixou de interessar ao cliente.

### Decisão

Adicionar `POST /me/tickets/:id/cancel`, que cancela exatamente um `Ticket` ainda `VALID` de uma sessão futura e libera somente a `ReservationSeat` daquele ingresso, sem tocar nos demais ingressos da compra. Não foi criado nenhum estado novo: a `Reservation` continua representável só por `PENDING | PAID | EXPIRED | CANCELLED`, e "parcialmente cancelada" é um fato derivado a cada leitura, nunca persistido — ela permanece `PAID` enquanto restar ingresso `VALID` ou `USED` e passa a `CANCELLED` somente quando todos forem cancelados. `POST /reservations/:id/cancel` (ADR-018) permanece disponível e foi ajustado para tolerar tickets já cancelados individualmente: ele cancela apenas os que ainda estão `VALID` e ignora os que não estão, preservando o comportamento anterior quando nenhuma compra parcial ocorreu.

A rota individual reaproveita a ordem de locks `Seat -> Reservation -> ReservationSeat -> Ticket` do cancelamento integral, restrita ao único assento/ingresso do alvo. Bloquear a `Reservation` inteira, mesmo para cancelar um único ingresso, é o que permite decidir com segurança se aquele era o último `Ticket` `VALID` e fechar a compra, serializando corretamente contra outro cancelamento (individual ou integral) da mesma reserva e contra o consumo pelo Gate.

### Alternativas consideradas

Modelar um `ReservationStatus.PARTIALLY_CANCELLED` persistido, permitir cancelamento individual apenas fora de uma compra com múltiplos assentos, ou reaproveitar a rota integral com uma lista de IDs de ingresso.

### Trade-offs

Derivar o estado "parcial" a partir dos `Ticket` evita duplicar informação e mantém a `Reservation` com a mesma máquina de estados já testada, ao custo de uma consulta adicional de contagem dentro da transação a cada cancelamento individual. Reaproveitar a ordem de locks existente manteve o raciocínio de concorrência já validado no ADR-018, sem introduzir uma segunda estratégia de coordenação com o Gate.

## ADR-021 — Mapa de assentos em tempo real por SSE de invalidação

### Contexto

O mapa dependia de polling a cada oito segundos. Reduzir a latência entre clientes diminui seleções de lugares já indisponíveis.

### Decisão

Adotar Server-Sent Events em `GET /sessions/:id/events` para sessões publicadas, com um papel deliberadamente restrito: o evento é apenas um **sinal de invalidação**, nunca o estado. O corpo carrega somente `{ "sessionId" }`; ao receber `sync` (abertura/reconexão) ou `seats-changed`, o cliente refaz `GET /sessions/:id/seats`, que continua sendo o snapshot autoritativo derivado do PostgreSQL. Assim o banco permanece a única fonte de verdade e nenhuma disponibilidade passa a viver em memória.

Os eventos são publicados exclusivamente **após o commit** das transações que realmente alteram disponibilidade: criação de hold, liberação de holds vencidos, pagamento recusado, pagamento aprovado (a representação pública muda de `HELD` para `SOLD`), cancelamento individual e cancelamento integral. Uma transação que sofre rollback não publica nada.

O fanout é um broadcaster em memória (`Map<sessionId, Set<listener>>`), sem Redis, WebSocket, fila ou broker. O polling de oito segundos permanece como rede de segurança: perder um evento atrasa a atualização, mas nunca produz estado incorreto permanente.

Para o instante em que um hold vence sem nenhuma requisição nova, um `setTimeout` por reserva publica uma invalidação em `expiresAt`. Ele é puro atalho de latência visual — a expiração continua decidida por `expiresAt` e pelo relógio do PostgreSQL, e perder o timer (por restart, por exemplo) apenas adia a atualização até o próximo `sync`, polling ou consulta.

### Alternativas consideradas

WebSocket bidirecional, long polling, reduzir o intervalo do polling atual, publicar o mapa completo dentro do evento, e PostgreSQL `LISTEN/NOTIFY` desde já.

### Trade-offs

SSE é unidirecional, roda sobre HTTP/1.1 comum, reconecta sozinho no navegador via `EventSource` e não exige dependência nova nem upgrade de protocolo no proxy — exatamente o que este fluxo precisa, já que o cliente nunca envia nada pelo canal. WebSocket traria handshake, biblioteca, heartbeat próprio e um segundo caminho de autorização sem benefício aqui. Enviar o mapa dentro do evento criaria um segundo caminho de leitura para o mesmo dado, com risco de divergir do snapshot e de vazar estado por um canal que não passa pela mesma checagem; o modelo de invalidação evita isso por construção.

A limitação real é o broadcaster em memória: com múltiplas réplicas da API, um cliente conectado à réplica A não recebe invalidações originadas na réplica B, e a atualização volta a depender do polling. A evolução natural é `LISTEN/NOTIFY` no PostgreSQL, que não foi implementada porque a topologia atual é de instância única e a correção não depende do canal em tempo real.

## ADR-022 — Edição segura de sessão publicada

### Contexto

A ADR-003 tornava `PUBLISHED` estruturalmente imutável, e a ADR-019 registrou a política desejada sem implementá-la. Na prática, a regra antiga também bloqueava para sempre sessões que nunca produziram consequência comercial: um hold abandonado de 10 minutos, já expirado e liberado, congelava a sessão de forma definitiva.

### Decisão

Publicar deixa de ser, por si só, motivo de bloqueio. A editabilidade passa a ser derivada pelo backend a partir do estado real, com o relógio do PostgreSQL, e exposta no contrato do organizador como `editability: { allowed, reason, layoutEditable }`.

Bloqueiam a edição: sessão já iniciada (`SESSION_STARTED`), hold `PENDING` ainda dentro do prazo e com alocação ativa (`ACTIVE_HOLD`) e histórico comercial — qualquer reserva `PAID` ou qualquer `Ticket` emitido, inclusive `USED` e `CANCELLED` (`COMMERCIAL_HISTORY`). Não bloqueiam: hold expirado e liberado, reserva `EXPIRED` sem ingresso e pagamento `DECLINED` sem ingresso com assentos liberados. A política nunca é `EXISTS Reservation`.

Quando permitida, a edição altera os mesmos campos do editor — snapshot do filme, data/hora, local, endereço, sala, preço e layout — e a sessão permanece `PUBLISHED` com `publishedAt` preservado. Nunca há rebaixamento artificial para `DRAFT`.

O layout tem uma restrição própria. Reconstruir o mapa apaga e recria `Seat`, e as FKs de `ReservationSeat` usam `RESTRICT`: qualquer alocação histórica, mesmo já liberada, impediria a reconstrução sem destruir histórico. Por isso `layoutEditable` é falso quando existe qualquer alocação para os assentos da sessão, e a tentativa retorna `SESSION_LAYOUT_NOT_EDITABLE` sem afetar os demais campos, que continuam editáveis.

A concorrência entre reserva e edição usa a ordem global `Session -> Seat -> Reservation -> ReservationSeat -> Ticket`. A criação de hold adquire `Session FOR SHARE` antes de ler preço e estrutura; a edição adquire `Session FOR UPDATE`. Reservas concorrentes não se bloqueiam entre si, mas excluem a edição. Se a reserva vence, a edição espera, revalida sob lock e é recusada pelo hold recém-criado; se a edição vence, a reserva espera e passa a ler o preço e a estrutura novos. Nenhuma reserva nasce sobre preço ou layout obsoletos. Nenhum outro fluxo — pagamento, portaria, cancelamento individual ou integral — trava a linha de `Session`, então prefixá-la à ordem não inverte lock algum. Após o commit de uma edição de sessão publicada, um evento `session-changed` é publicado no canal SSE do P0.2.

### Alternativas consideradas

Manter `PUBLISHED` sempre imutável, decidir a elegibilidade apenas no frontend, usar `EXISTS Reservation` como política, apagar o histórico liberado para permitir a reconstrução do layout, e versionar sessões publicadas.

### Trade-offs

O organizador recupera flexibilidade real sem colocar em risco nenhuma compra: a política é revalidada dentro da transação, com os locks já adquiridos, de modo que o `editability` do `GET` é um indicativo para a UI, nunca a autorização final. O custo é uma consulta agregada a mais por leitura e a assimetria entre `allowed` e `layoutEditable`, que precisa ser explicada na interface. Preservar o histórico liberado foi escolhido em vez de apagá-lo para permitir a troca de layout.

## ADR-023 — Painel operacional e receita simulada vigente

### Contexto

O organizador via os dados cadastrais da sessão, mas não a operação: quanto foi vendido, quanto está em hold e quanto restou. Sem uma definição explícita, "receita" ficaria ambígua depois que o P0.1B passou a permitir cancelar um ingresso isolado de uma compra paga.

### Decisão

Expor `metrics` no contrato do organizador, calculadas pelo backend em uma única consulta agregada — em lote na listagem, sem N+1. Cada agregado sai de uma subconsulta independente sobre `ReservationSeat`, nunca de JOINs empilhados na mesma linha, o que evita multiplicar contagens e receita por produto cartesiano.

Definições: `capacity` é o total de `Seat`; `heldSeats` são alocações ativas de reservas `PENDING` ainda dentro do prazo pelo relógio do banco; `soldSeats` são alocações **ainda ativas** de reservas `PAID`; `availableSeats` é `capacity - heldSeats - soldSeats`; `occupancyPercentage` é `soldSeats / capacity`, com `capacity = 0` tratado como zero em vez de divisão por zero.

`simulatedRevenueCents` é a **receita operacional simulada vigente**: a soma de `unitPriceCents` exatamente das alocações contadas em `soldSeats`. Ela é deliberadamente diferente do histórico financeiro bruto. Uma compra de dois assentos a R$ 28 com um ingresso cancelado individualmente rende R$ 28 de receita vigente, enquanto o `Payment` aprovado permanece `APPROVED` com R$ 56, intacto como histórico. Um ingresso `USED` continua contando: entrar na sala não devolve o assento.

### Alternativas consideradas

Somar `Payment.amountCents` das compras aprovadas, somar `Payment` descontando cancelamentos, simular estorno financeiro, e calcular as métricas no frontend a partir do mapa de assentos.

### Trade-offs

Derivar a receita da alocação ativa mantém uma única fonte de verdade — o mesmo predicado `releasedAt IS NULL` que governa disponibilidade e double-booking — e responde corretamente a cancelamento parcial sem inventar refund. Em troca, o número não bate com a soma dos pagamentos aprovados, e essa diferença precisa ser nomeada com clareza no produto e na documentação.

## ADR-024 — Duplicação estrutural de sessão

### Contexto

Publicar a mesma sessão em outro horário exigia recadastrar filme, local, sala, preço e layout do zero, incluindo uma nova busca na TMDb.

### Decisão

`POST /organizer/sessions/:id/duplicate` cria um novo `DRAFT` a partir de uma sessão própria, `DRAFT` ou `PUBLISHED`. A cópia é exclusivamente estrutural: snapshot do filme já persistido, local, endereço, sala, preço e o formato do layout, gerando `Seat` com identificadores inteiramente novos.

Nada transacional é copiado — `Reservation`, `ReservationSeat`, `Payment`, `Ticket` e `SharedTicketLink` pertencem à origem e continuam apenas nela. A cópia nasce `DRAFT` com `publishedAt` nulo, nunca herdando a publicação. A TMDb não é consultada de novo: o snapshot local já é a fonte de verdade do filme. Tudo ocorre em uma única transação; uma falha na criação dos assentos não deixa sessão órfã.

Data e hora são copiadas provisoriamente para que o editor abra preenchido, e a interface orienta explicitamente a revisar data e horário antes de publicar.

### Alternativas consideradas

Duplicar apenas rascunhos, exigir o novo horário no corpo da requisição, copiar as linhas de `Seat` preservando identificadores, e reconsultar a TMDb para atualizar o snapshot.

### Trade-offs

Copiar o horário evita um formulário obrigatório e mantém o fluxo em um clique, ao custo de exigir um aviso claro para que ninguém publique uma cópia no mesmo horário sem querer. Reaproveitar o snapshot local mantém a duplicação independente da TMDb e determinística, mas a cópia não incorpora correções que o catálogo externo tenha recebido desde a criação da origem.

## ADR-025 — Base demo final

### Contexto

A programação semeada foi dimensionada quando o produto tinha menos superfícies. Com edição segura, painel operacional, duplicação, tempo real e os dois cancelamentos entregues, oito sessões de três filmes em duas datas não sustentam mais a revisão: faltam alternativas de horário, sobra repetição e não há uma separação explícita entre a sessão usada para demonstrar bloqueio comercial e as sessões que precisam permanecer editáveis.

### Decisão

A base demo passa a ter catorze sessões `PUBLISHED` e dois `DRAFT`, com cinco snapshots de filme, dois cinemas e quatro salas de layout fixo, distribuídas em três datas futuras. Sala deixa de ser texto repetido por sessão e vira um registro com local, endereço e layout, de modo que o mesmo espaço não possa aparecer com capacidades diferentes.

Os horários são os de uma grade real de exibição — 13:40, 15:40, 16:20, 18:15, 18:40, 18:50, 19:20, 19:40, 20:15, 21:05, 21:20, 22:40 —, nunca uma sequência de horas cheias, e uma sala só recebe a próxima sessão depois da duração do filme mais um intervalo de limpeza. As datas continuam derivadas do calendário de `America/Sao_Paulo` por deslocamento em dias sobre o instante do seed, com aritmética em UTC para atravessar viradas de mês e de ano.

O volume transacional é deliberadamente mínimo. Exatamente uma sessão — Matrix às 15:40 — carrega uma compra paga de um assento com pagamento aprovado e um único ingresso `VALID`, suficiente para demonstrar `COMMERCIAL_HISTORY` na edição, receita simulada vigente no painel e o roteiro completo da portaria. Nenhuma outra sessão nasce com reserva, pagamento ou ingresso, e o seed não fabrica ingressos `CANCELLED` ou `USED` para simular movimento.

Todos os identificadores de sessão anteriores são preservados e reaproveitados pela nova grade. O seed permanece exclusivamente de `upsert` e `createMany` com `skipDuplicates`, sem apagar nada: um banco já semeado converge para a base nova em vez de acumular sessões órfãs.

### Alternativas consideradas

Manter a grade anterior, gerar dezenas de sessões para simular um catálogo real, randomizar horários a cada execução, semear compras e cancelamentos em várias sessões para preencher métricas, e apagar as sessões antigas antes de recriar a programação.

### Trade-offs

Uma grade com repetição de sala e respeito à duração do filme é mais trabalhosa de manter do que uma lista solta de horários, e o teste que a protege precisa conhecer a duração de cada snapshot. Em troca, a programação suporta leitura próxima sem revelar horários impossíveis. Reaproveitar os identificadores antigos evita órfãos, mas amarra os nomes internos das constantes à história do projeto: `interstellarEarly` e `matrixLate`, por exemplo, descrevem posições que mudaram de horário. Manter apenas um ingresso `VALID` deixa as contas de cliente visualmente limpas e o painel com números pequenos e verificáveis, ao custo de não exibir uma sessão quase esgotada.

## ADR-026 — Limite de tentativas de login e cabeçalhos de segurança

### Contexto

Uma revisão de segurança da API encontrou dois vazios. `POST /auth/login` aceitava tentativas ilimitadas: doze senhas erradas contra a mesma conta foram respondidas em 443 ms, todas com `401`. O Argon2id torna cada tentativa cara, mas o custo é do servidor, não do atacante — um fluxo constante contra uma conta conhecida é, na prática, um dreno de CPU com um palpite grátis embutido. E nenhuma resposta trazia cabeçalho de segurança algum.

### Decisão

Limitar tentativas malsucedidas **por origem da requisição, e nunca por conta**: vinte falhas em uma janela deslizante de quinze minutos passam a exigir um cooldown de sessenta segundos, respondido com `429` e `Retry-After`. A verificação acontece **antes** de `argon2.verify`, para que uma origem abusiva pare de consumir hash.

A chave não conter o e-mail é a decisão central, e ela substitui uma primeira versão que usava `e-mail + origem`. Naquele desenho o bloqueio era anterior à conferência da senha, então a senha correta também era recusada durante o cooldown; como cada nova falha reiniciava o minuto, bastava uma tentativa errada por minuto para manter uma conta conhecida permanentemente indisponível. Com as credenciais de demonstração publicadas no README, isso seria uma negação de serviço trivial contra a demonstração — exatamente o oposto do que a proteção deveria fazer. Tirando a conta da chave, um cliente abusivo passa a limitar apenas a si mesmo e nenhum bloqueio direcionado a conta continua possível.

O escopo real da proteção também foi renomeado com honestidade: ela protege a CPU do servidor contra um cliente que dispara Argon2 em série. Ela **não** é uma defesa contra adivinhação de senha das contas de demonstração, que não têm segredo a proteger. Para contas reais, o custo do Argon2id por tentativa continua sendo o limitador principal.

`TRUST_PROXY` passou a existir porque a chave só significa "cliente" quando `request.ip` é o endereço real. Atrás do proxy de uma plataforma e com a variável desligada, todos os clientes compartilham a mesma origem e o limite vale para o conjunto; por isso o limiar é alto — vinte falhas em quinze minutos, longe de qualquer tráfego legítimo — e o cooldown é de apenas um minuto. Confiar em `X-Forwarded-For` sem proxy permitiria forjar a origem, então o padrão é desligado.

Os cabeçalhos `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e `X-Frame-Options: DENY` são aplicados em um hook `onRequest`, não `onSend`. O stream SSE de `GET /sessions/:id/events` chama `reply.hijack()` e copia manualmente `reply.getHeaders()`; hooks de `onSend` nunca rodam para respostas sequestradas, então defini-los ali deixaria justamente o endpoint de conexão longa descoberto.

### Alternativas consideradas

Adicionar `@fastify/rate-limit` e `@fastify/helmet`, limitar apenas por IP, limitar apenas por e-mail, bloquear a conta de forma persistente no banco, exigir CAPTCHA, e aplicar uma `Content-Security-Policy` restritiva.

### Trade-offs

O estado do limite é em memória e vale por processo — a mesma limitação já assumida no broadcaster do ADR-021. Com múltiplas réplicas o teto efetivo passa a ser vinte tentativas por réplica, o que ainda reduz a taxa, mas deixa de ser global; um limite compartilhado exigiria Redis, infraestrutura que esta topologia de instância única não justifica. O mapa é podado e tem teto de chaves para que um cliente variando a origem não o transforme em vazamento de memória. O preço aceito por eliminar o bloqueio por conta é que a proteção deixa de ser específica de credencial: um atacante distribuído por várias origens não é contido por ela.

Duas dependências foram descartadas em favor de aproximadamente cem linhas próprias. `@fastify/rate-limit` resolveria o caso genérico, mas a decisão que importa aqui — chave composta, recusar a senha correta durante o bloqueio, verificar antes do Argon2 — é justamente a que a configuração padrão não toma. `helmet` traria um conjunto amplo em que `Cross-Origin-Resource-Policy` quebraria o frontend, que roda em outro site e consome esta API de forma legitimamente cross-site, e cuja CSP quebraria o Swagger UI. Preferiu-se o conjunto pequeno que se entende inteiro.

## ADR-027 — Recuperação de leituras públicas

GETs públicos de programação, sessão, assentos e compartilhamento fazem no máximo cinco tentativas em falhas transitórias. Intervalos base: 1,5 / 3 / 5 / 8 segundos, jitter de até 249 ms e timeout de oito segundos por tentativa. Retry-After prevalece quando maior; se ultrapassar trinta segundos, o erro é apresentado em vez de antecipar a requisição. AbortSignal encerra fetch e espera. Após 1,5 segundo, a página informa a inicialização fora da região aria-busy.

Login, GETs autenticados e escritas ficam fora dessa política. Um erro de rede não informa se uma escrita foi confirmada. Erros finais preservam tentativa manual. A mensagem indica possibilidade de inicialização, não um diagnóstico comprovado da infraestrutura.

## ADR-028 — Idempotência adiada, integridade mantida

### Contexto

Locks e constraints impedem duplicação de alocações ativas, pagamentos e consumo, mas não reproduzem a resposta anterior. Após uma resposta perdida, criar a mesma reserva pode retornar SEAT_UNAVAILABLE; pagar a mesma reserva retorna PAYMENT_ALREADY_PROCESSED. Isso é integridade, não idempotência de requisição.

### Decisão

Não adicionar Idempotency-Key nesta rodada. O pagamento é uma transição local simulada, sem débito externo, e o frontend não repete escritas automaticamente. O ID da reserva permite consultar seu estado; ingressos emitidos aparecem em Meus ingressos. Se a resposta de criação se perde antes de o ID chegar ao navegador, não existe recuperação transparente: o hold pode ocupar os lugares até expirar em dez minutos. Essa limitação é aceita e documentada.

Armazenamento genérico de respostas, retenção e replay adicionariam um segundo ciclo de vida sem resolver uma integração financeira real. Cancelamento retorna conflito se já concluído, portaria retorna ALREADY_USED e recriar compartilhamento rotaciona o token; essas semânticas também não são replay HTTP.

### Evolução

Antes de automatizar retry de escrita ou integrar um provedor, persistir chave por usuário/operação, hash canônico do payload, resultado e expiração. Inserção única e lock da chave devem ocorrer na mesma transação do efeito local; payload distinto retorna 409. Chaves iguais concorrentes aguardam o mesmo commit. Retenção deve cobrir a janela de retry, com política de exclusão explícita; reuso após expiração é operação nova. Efeitos externos exigem idempotência do provedor e reconciliação/webhooks, não promessa de exactly-once baseada só no banco local. Testar resposta perdida, concorrência, conflito de payload, rollback e expiração antes de habilitar clientes.

## ADR-029 — Hardening sem nova infraestrutura

A API mantém CORS por origem exata, respostas sem cache, headers em onRequest inclusive SSE, HSTS sob HTTPS confiável e CSP própria do Swagger. O frontend tem CSP em vercel.json: scripts locais, conexão restrita à API real, imagens TMDb e câmera na própria origem. Estilos inline continuam autorizados para estilos dinâmicos React; scripts inline e eval não. Trocar VITE_API_URL de produção exige ajustar connect-src.

Fastify e Swagger UI foram atualizados por alertas de segurança. Dois overrides restritos ao tooling Prisma corrigem deepmerge-ts e mysql2 sem migrar o ORM para uma versão candidata. Removê-los quando uma versão estável incorporar as correções. A aplicação usa PostgreSQL, mas a ferramenta instalada também faz parte da manutenção. Prisma validate/generate, migrations do zero, seed e testes verificam a compatibilidade exercitada.

Axe-core foi adicionado só como dependência de desenvolvimento para verificar acessibilidade nos componentes existentes. Não foi introduzido framework visual ou segundo test runner.
