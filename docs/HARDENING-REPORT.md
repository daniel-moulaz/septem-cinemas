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
