# Relatório de hardening — 25/09/2026

Rodada sobre o commit inicial `d5fe331`, na branch `hardening`. Implementação e validação locais concluídas. Este relatório não afirma que os commits foram publicados ou que a hospedagem já executa esta versão.

## Baseline e validação final

Ambiente: Windows, Node.js 24.19.0, PostgreSQL 17 em container local dedicado. O banco inicial estava desligado: a primeira execução não foi considerada evidência de regressão da API. Depois de aplicar migrations e seed, o baseline reproduzível foi:

| Verificação | Inicial | Final |
|---|---|---|
| Instalação pelo lockfile | `npm ci` passou | `npm ci` passou novamente |
| Audit de dependências | 8 alertas: 6 altos, 2 moderados | 0 alertas no momento da execução |
| API | 191 testes, 18 arquivos, todos passaram | **236 testes, 21 arquivos, todos passaram** |
| Frontend | 17 testes, 5 arquivos; 16 passaram e 1 falhou | **73 testes, 8 arquivos, todos passaram** |
| Lint | Passou | Passou com `--max-warnings=0`, incluindo scripts e testes web |
| Typecheck | Passou | Passou nos dois workspaces |
| Builds | Passaram em execução separada | Passaram dentro de `npm run check` |
| `npm run check` | Falhou no teste de edição do frontend | **Exit code 0** |
| Prisma/migrations | Sete migrations aplicadas na preparação | Sete migrations aplicadas novamente em outro banco vazio |
| Seed | Fixtures preparadas | Duas execuções bem-sucedidas no banco novo |
| Mutation proof | Runner inexistente | Controles passaram, duas mutações detectadas, controle restaurado passou |

Total final, incluindo o ajuste de retrocompatibilidade: **309 testes em 29 arquivos**, sem falhas ou skips nas suítes completas. São 101 casos adicionais em relação aos 208 casos existentes, além da correção do caso que falhava. Os testes selecionados pelo runner de mutação são execuções adicionais dos mesmos casos, não entram novamente nessa contagem. Não foi medido percentual de cobertura nem throughput.

O ajuste de compatibilidade acrescentou 28 casos de API e oito de frontend aos 273 casos aprovados na primeira entrega. Testes direcionados: 61 casos de autenticação/ingressos e 12 de App passaram. Depois, npm run check executou as suítes completas acima, lint, Prisma validate/generate, typecheck e os dois builds com exit code 0. A mutation proof foi repetida e passou. Não houve alteração de dependências, schema, migrations ou dados de produção nesse ajuste; as integrações usaram somente o banco local dedicado.

Exigir claims de autenticação revelou que 44 chamadas de assinatura nas fixtures substituíam os defaults ao fornecer opções só com sub. Elas passaram a fornecer sub no payload, preservando o signer configurado com emissor, destinatário e expiração reais. A validação não foi relaxada para acomodar as fixtures. Os testes de contrato também criam assinaturas independentes para verificar rejeição de claims ausentes, pares cruzados/desconhecidos, assinatura, algoritmo, segredo de outra finalidade e expiração. O consumo de QR anterior seguido do atual, e na ordem inversa, confirma apenas uma entrada para o mesmo ingresso, sem reescrever seus dados ao consultar o QR.

O baseline falhava porque o teste de SessionEditor fixava uma data que já havia passado. A fixture agora calcula uma sessão futura. O build independente do baseline foi executado após o início dos primeiros ajustes; não é apresentado como um `check` original aprovado.

O npm local avisa que scripts de instalação de Prisma, engines, Argon2 e esbuild ainda não estão cobertos pela política `allowScripts`. A instalação retornou zero; geração, migrations, hashing exercitado pelos testes e builds funcionaram. Esse warning de política permanece registrado, sem aprovação indiscriminada de scripts. Não houve warnings de lint ou build.

## Problemas encontrados e mudanças

- Leituras públicas falhavam antes da API acordar. `public-read.ts` centraliza recuperação somente para GETs públicos: 408/425/429/500/502/503/504, falha de rede e timeout. São cinco tentativas no máximo, timeout de oito segundos por tentativa e esperas base de 1,5/3/5/8 segundos com jitter de até 249 ms. `Retry-After` é respeitado; acima de trinta segundos, interrompe a recuperação automática. AbortSignal cancela fetch e espera. Login, GET autenticado e escrita não recebem retry.
- `ServerStartingNotice` informa a espera após 1,5 segundo no catálogo, sessão e ingresso compartilhado. Fica fora da região `aria-busy`; loading, erro final e tentativa manual permanecem. A mensagem não comprova a causa de uma indisponibilidade.
- Respostas atrasadas podiam atingir telas já substituídas. Carregamento público, autenticação restaurada, seletor de filme e editor agora verificam cancelamento. Atualizações estruturais de sessão cancelam a leitura anterior.
- O editor não encaminhava a cópia para a navegação da área do organizador. O callback foi conectado e testado pelo componente pai. Duplicação aguarda alterações salvas e bloqueia saída durante a operação. Sessão publicada deixou de oferecer uma ação de publicação sem efeito.
- O editor concentrava apresentação, estado e efeitos. Após ampliar regressões de salvar, publicar, duplicar e realtime, `SessionEditor.tsx` passou de 1.130 para 537 linhas. `useSessionEditor.ts` coordena carregamento/operações; `SessionPresentation.tsx` reúne apresentação operacional. `useSessionForm` continua responsável pelo formulário. São duas extrações coesas, sem pulverização em componentes triviais.
- Eventos recebidos durante uma leitura operacional agora geram uma reconsulta pendente; polling de oito segundos recupera ausência de EventSource. O formulário em edição é preservado. Leituras são abortadas durante mutações para não substituir seus resultados.
- `sessionStorage` indisponível não derruba a aplicação: login pode permanecer em memória. Testes cobrem restauração expirada, falha de login e logout/login.
- Axe encontrou um `aria-label` em elemento sem papel apropriado no sistema de toast; foi corrigido para uma região. O catálogo recebeu separação textual para um nome acessível legível. Catálogo, mapa/detalhe, editor, portaria e autenticação têm verificações de acessibilidade/teclado conforme o risco.
- A rota inexistente usava resposta diferente do contrato de erro. Ela agora segue `{ error, message }`. Erros de framework e inesperados recebem mensagens seguras. Testes verificam validação, 401, 403, 404, 409, JSON malformado e exceção simulada de banco sem SQL, caminhos, secrets ou stack no corpo público.
- Logs de requisição omitem query strings e credenciais no caminho de compartilhamento, inclusive rotas não reconhecidas. Logs internos de exceção continuam disponíveis. Isso não controla logs do proxy.
- SSE encerra streams que saturam o buffer, removendo inscrição e heartbeat. Um teste específico verifica o encerramento e ausência de timers; a recuperação continua por reconexão/polling.

## Concorrência e idempotência

As garantias de reserva existentes foram preservadas: transação, coordenação por locks ordenados e índice parcial de alocação ativa. Não foi adicionado um lock redundante ou substituído SQL correto.

`scripts/concurrency-proof.mjs` copia o código atual para um diretório temporário e cria seu próprio banco local. O original nunca é modificado. A prova observou:

```text
Control: locks + unique index: passed
Mutation A: remove Seat FOR UPDATE: mutation detected by the intended assertion
Locks alone: HTTP arbitration remains protected: passed
Mutation B: remove active-allocation uniqueness: mutation detected by the intended assertion
Restored control: passed
Concurrency proof complete; original files were never modified.
```

A mutação A falha na observação das duas requisições esperando o lock em `pg_stat_activity`. Isso detecta perda da coordenação, sem alegar venda dupla causada apenas pela remoção do lock. A mutação B permite a duplicação direta que o teste exige rejeitar. O controle HTTP ainda passa sem o índice: essa distinção demonstra por que as duas provas são necessárias. O runner exige falha específica, não qualquer exit code diferente de zero. Ao final, não restou banco `septem_proof_*` no servidor de teste.

**Idempotency-Key não foi implementado**, conforme ADR-028. Pagamento é simulado, escritas não têm retry automático e a persistência já impede dupla finalização. Isso não equivale a replay da resposta: uma criação cuja resposta se perdeu pode manter hold desconhecido até expirar. O ADR descreve chave por usuário/operação, hash do payload, transação, conflito, retenção e reconciliação para uma futura integração real. Não há implementação parcial nem flag de bypass em produção.

## Segurança, dependências e deploy

CORS continua por origem exata; `Retry-After` é exposto ao browser. Headers globais são aplicados em `onRequest`, incluindo SSE: no-store, nosniff, no-referrer, frame deny e restrição de permissões. HSTS depende de HTTPS reconhecido e configuração confiável de proxy. Swagger aplica CSP própria e seu HTML/asset JavaScript foram exercitados.

`apps/web/vercel.json` define CSP compatível com scripts locais, API real, imagens TMDb e câmera na própria origem. Estilos inline seguem permitidos por uso dinâmico do React. Essa configuração ainda precisa ser observada após rollout na Vercel; o servidor Vite local não aplica headers da plataforma.

| Dependência | Mudança |
|---|---|
| Fastify | 5.12.0 → 5.12.5 |
| Swagger UI | 5.2.6 → 6.1.1; compatibilidade com Fastify 5 conferida no pacote e nos testes |
| deepmerge-ts | Override 8.0.0 restrito a `@prisma/config` |
| mysql2 | Override 3.24.4 restrito ao tooling `prisma`; a aplicação continua usando PostgreSQL |
| axe-core | 4.13.0, nova dependência exclusivamente de desenvolvimento |

Transitivos foram atualizados no lockfile. Não houve nova dependência direta de runtime nem remoção de dependência direta. Os overrides evitam migrar o ORM para uma versão candidata apenas para corrigir transitivos; devem sair quando uma versão estável incorporar as correções. A validação limpa exerceu Prisma validate/generate, migrations, seed e integrações. Audit zero é um resultado pontual, não garantia de ausência de vulnerabilidades.

Não há migration nova: as sete existentes continuam sendo a fonte do schema. Não foram introduzidos Redis, microsserviços, filas ou infraestrutura adicional. `check` agora inclui validação Prisma e lint do repositório; a CI executa também a mutation proof. Os comandos equivalentes rodaram localmente; não foi executado um job remoto Ubuntu/Node 22 nesta sessão.

## Identidade e documentação

Raiz `septem-cinemas`, workspaces `@septem/api` e `@septem/web`, lockfile, scripts, exemplos, Compose, Railway e CI estão consistentes. O remote local foi atualizado para `daniel-moulaz/septem-cinemas` após confirmar que o repositório existe. README apresenta produto, demo, papéis e engenharia. Documentação de requisitos/arquitetura/decisões foi revisada; registros extensos obsoletos de uso de IA foram substituídos por descrição factual, preservando o histórico Git.

Foram criados [CONCURRENCY-PROOF](CONCURRENCY-PROOF.md), [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md), [OPERATIONS](OPERATIONS.md) e este relatório. Nenhum histórico Git foi reescrito. Arquivos locais antigos de contexto, já ignorados pelo Git, foram arquivados fora do repositório.

A apresentação pública mantém somente as três referências necessárias ao domínio real da API: duas no README e uma em connect-src. Identificadores de protocolo anteriores ficam restritos à aceitação retrocompatível no código e às fixtures de teste. Não houve troca estética de URL de produção, credenciais locais ou nomes de banco/volume já provisionados.

**Compatibilidade de rollout:** SEPTEM emite apenas a identidade atual, mas mantém validação retrocompatível dos contratos legítimos anteriores. A interrupção inicialmente identificada foi corrigida: tokens e QRs anteriores ainda válidos são aceitos, sem exigir novo login ou regeneração por causa da renomeação. O frontend migra o armazenamento após validar a sessão. Assinatura, expiração, finalidade e pares completos continuam obrigatórios; códigos manuais e dados persistidos permanecem. ADR-030 e o runbook documentam a transição. Credenciais já expiradas, revogadas pelo estado do ingresso ou removidas do navegador não são recuperadas.

## Smoke realizado e limites da validação

Contra API HTTP local em execução, banco dedicado e integração TMDb real:

- Organizador: login/me → catálogo TMDb → criar rascunho → editar sala → publicar.
- Público: catálogo → sessão publicada → assentos.
- Cliente: login → reserva → aprovação → três ingressos → compartilhamento público sem e-mail → cancelamento elegível → revogação do link.
- Portaria: consumir token QR assinado → recusar repetição por código manual → consumir outro ingresso por código manual.
- SSE: `sync` inicial e `seats-changed` após criação da reserva.
- Repetição de pagamento: 409 `PAYMENT_ALREADY_PROCESSED`; rota inexistente: 404 seguro; acesso sem token: 401; novo login: aprovado.
- Swagger HTML/CSP e OpenAPI JSON: responderam; frontend Vite: HTTP 200.

Cold start, falhas de rede, esgotamento de retries, cancelamento, retry manual e logout/login foram verificados em testes de interação com timers controlados. Não foi induzido cold start na hospedagem pública.

O ambiente retornou inventário vazio de navegadores. Portanto, **smoke visual, headers CSP aplicados pela Vercel, foco nativo de dialog, contraste renderizado, leitor de tela e câmera física não foram verificados nesta sessão**. Axe roda em jsdom com a regra de contraste desabilitada; os métodos nativos de dialog são simulados. Validação de token QR por HTTP não equivale a escanear uma imagem com câmera.

Continuam deliberadamente fora desta rodada: integração financeira/refund, idempotência de escrita, revogação imediata de JWT, fanout SSE entre réplicas, rate limit distribuído, limite global de streams, paginação, agenda global de salas, deep links do organizador e contratos gerados. As consequências e caminhos de evolução estão em KNOWN-LIMITATIONS. Não há teste falhando conhecido no resultado final; as verificações manuais acima permanecem pendentes.

URLs canônicas de repositório e demo estão no [README](../README.md). Nenhum push, merge ou deploy foi realizado nesta rodada.

## Rollout em produção (2026-09-25)

Depois do merge em `main` (`e2592df`):

- **Vercel:** o primeiro deploy falhou porque o Build Command salvo no projeto ainda apontava para `@elite-dev/web`; nenhum arquivo do repositório continha esse valor. `apps/web/vercel.json` passou a fixar install e build do monorepo (`6bed786`) e o valor do dashboard foi alinhado. O domínio público serve o bundle desse build, com a CSP e os headers de `vercel.json` aplicados.
- **Railway:** os deploys de `e2592df` e `6bed786` foram recusados na validação de configuração (`Free plan deployments must be serverless`): o workspace está no plano Free e o serviço está com App Sleeping desativado. O build passou; a recusa ocorre antes do pre-deploy, então nenhuma migration rodou. A produção seguiu no deployment de 27/08 (`37e755e`, logs com `@elite-dev/api`) até a correção abaixo.
- **500 em `/sessions`:** os logs do deployment ativo mostram `57P03 the database system is starting up` na primeira consulta depois que serviço e PostgreSQL acordam; as requisições seguintes responderam 200. É indisponibilidade transitória de cold start, em código anterior a esta rodada, e não regressão.

Smoke no domínio público com Chrome headless via DevTools Protocol, frontend novo sobre a API `37e755e`:

- Cold start real, com API e banco dormindo: aviso "Inicializando o servidor…" após 1,5 s → 500 `57P03` → retry automático → 200. Programação exibida em ~9,5 s sem ação do usuário.
- Programação → sessão → mapa com 40 assentos. Deep link direto para a sessão também carregou.
- API indisponível, com 503 injetado no navegador: cinco tentativas em ~18,7 s, aviso removido e erro final com Tentar novamente. O clique recuperou a programação.
- Falhas transitórias na sessão (duas conexões recusadas e dois 503): mapa carregado automaticamente em ~7 s, sem botão de retry.

A ordem do runbook (API antes do frontend) ficou invertida porque a API não pôde ser publicada. O frontend novo não depende de contrato novo da API: sem `Retry-After` exposto pela API antiga, o cliente usa o próprio backoff, e a API antiga só emite a identidade anterior.

### Publicação da API

A reativação de App Sleeping estava staged no painel e não havia sido aplicada. Depois de aplicada, o deploy de `977898d` falhou no pre-deploy com `P1001` porque o PostgreSQL dormia. Com o banco acordado por uma leitura pública, o novo deploy passou: `No pending migrations to apply`, healthcheck 200 e logs com `@septem/api`. Os headers exclusivos desta rodada (`Cache-Control: no-store`, `Permissions-Policy` e HSTS) confirmaram a versão em produção.

Smoke autenticado em produção, pela API e pela UI em Chrome headless:

- Organizador: login com contrato SEPTEM → rascunho com snapshot TMDb → rascunho oculto do público → edição de horário e preço → publicação → segunda publicação recusada com 409 → sessão visível na programação e na área do organizador.
- Cliente: login SEPTEM → reserva de três lugares com hold de dez minutos → mesmo lugar recusado para outra conta → pagamento aprovado → três ingressos com QR (`septem-cinemas-api`/`septem-cinemas-gate`) e código manual → repetição do pagamento recusada → ingresso alheio respondido como 404 → cancelamento individual com lugar liberado. Pela UI: login pedido ao reservar, compra, ingresso com QR, cancelamento, logout limpando a credencial, login exigido em Meus ingressos e novo login.
- Compatibilidade legada: a chave anterior de armazenamento foi restaurada e migrada para a chave SEPTEM pela UI. JWTs e QRs com o contrato anterior não foram forjados em produção, porque isso exigiria os segredos reais; esses casos seguem cobertos pela suíte de integração da CI.
- Portaria: QR `VALID` → mesmo QR e código manual `ALREADY_USED` → código manual em minúsculas `VALID` → ingresso cancelado `INVALID` → outra sessão `WRONG_EVENT` → credencial inválida `INVALID`. Na UI, o código manual de um ingresso consumido exibiu "INGRESSO JÁ UTILIZADO".
- SSE: `text/event-stream`, `X-Accel-Buffering: no`, `sync` inicial e `seats-changed` após hold, pagamento e cancelamento.
- Erros: 404, 401, 403, 400, 409 e login inválido retornam apenas `error`/`message`; e-mail inexistente responde igual a senha errada.
- CORS: o preflight do frontend é aceito e expõe `Retry-After`. A API responde sempre com a origem configurada, e um navegador em outra origem teve leitura e preflight bloqueados.
- Swagger UI com CSP própria e OpenAPI 3.0.3 com 24 rotas. Os logs do deployment não registraram 5xx durante o smoke.
- Cold start da API nova, com serviço e banco dormindo: 500 (erro de conexão do Prisma), 500 (`57P03`) e 200. Aviso exibido em 2,4 s e programação carregada em 8,1 s sem ação do usuário.

Resíduo do smoke: a sessão de Oppenheimer de 25/09, às 19:00, integra a programação demo e mantém E5 e E6 vendidos e consumidos na portaria, porque ingressos usados não podem ser cancelados. As compras restantes do smoke foram canceladas e seus lugares, liberados.

### Programação demo

A programação pública tinha uma única sessão futura: as sessões do seed já haviam passado. O seed não foi executado na base pública, porque moveria sessões antigas com vendas. A semana de 25/09 a 01/10 foi criada pelo fluxo do organizador, com snapshot TMDb, rascunho e publicação, nos quatro layouts de sala do seed. Ela reúne sete filmes com quatro sessões cada — Ainda Estou Aqui, Oppenheimer, Godzilla Minus One, Barbie, Mad Max: Estrada da Fúria, Homem-Aranha: Através do Aranhaverso e Duna: Parte Dois —, totalizando 28 sessões publicadas, sendo uma já existente. Os preços variam de R$ 24 a R$ 36, e não há sobreposição na mesma sala, considerando a duração do filme mais 20 minutos. A validação na UI abriu uma sessão de cada filme a partir de "Em cartaz", com mapa completo, horário igual ao da API e todas as imagens TMDb carregadas em desktop e mobile.

## Commits

| Commit | Conteúdo |
|---|---|
| `2037787` | Identidade dos packages e manutenção de dependências |
| `e24d5ca` | Recuperação de leituras públicas e storage indisponível |
| `24009c5` | Editor, navegação e testes de interação/acessibilidade |
| `535c904` | Erros públicos, logs, headers e recursos SSE |
| `fa88cf2` | Mutation proof e verificação na CI |
| `4469e50` | README, runbook, limitações e relatório inicial |

O ajuste posterior fica em um commit separado, `fix(auth): preserve legacy credentials with strict contract pairs`, com código, testes e atualização desta documentação. Seu hash pode ser consultado no histórico da branch.
