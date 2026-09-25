# Limitações conhecidas

## Pagamento e recuperação de escrita

**Limitação:** aprovação/recusa são simuladas; não há adquirente, webhook, refund financeiro ou Idempotency-Key.

**Impacto:** o banco impede dupla finalização, mas não reproduz a resposta anterior. Uma resposta de criação perdida pode deixar um hold cujo ID o navegador desconhece até expirar. Cancelamento mantém o pagamento como histórico, sem devolver dinheiro real.

**Decisão atual:** concentrar o escopo em concorrência, emissão e operação. Escritas não recebem retry automático. O estado de uma reserva conhecida e os ingressos podem ser consultados após uma falha.

**Evolução:** idempotência persistente, integração do provedor e reconciliação antes de transacionar dinheiro; ver ADR-028.

## Cold start e disponibilidade

**Limitação:** a infraestrutura hospedada pode iniciar sob demanda ou ficar indisponível.

**Impacto:** o primeiro carregamento pode demorar; falhas persistentes terminam no estado de erro após tentativas limitadas.

**Decisão atual:** timeout de oito segundos por tentativa pública, backoff e mensagem após 1,5 segundo. Não há SLA contratado ou medido neste repositório.

**Evolução:** manter instância ativa, monitoramento externo e dimensionamento conforme tráfego real.

## SSE e limitação de login por processo

**Limitação:** broadcaster, timers de expiração e throttle de login vivem em memória. O limite conta falhas concluídas; não é controle de concorrência de verificações Argon2.

**Impacto:** múltiplas réplicas não compartilham eventos ou contadores; restart perde timers e cooldowns. Rajadas paralelas e origens distribuídas não são totalmente contidas. Clientes atrás do mesmo NAT podem compartilhar o limite.

**Decisão atual:** instância única, polling de recuperação e PostgreSQL para integridade. Streams que saturam o buffer são encerrados para reconexão. Não há limite global de conexões SSE na aplicação.

**Evolução:** proteção de tráfego na borda, limite de concorrência de hash e fanout entre processos, por exemplo LISTEN/NOTIFY, quando a operação exigir. Não confundir os limites locais com proteção completa contra DDoS.

## Autenticação e credenciais de ingresso

**Limitação:** contas demonstrativas, JWT de oito horas sem revogação imediata e token no sessionStorage. Não há cadastro, recuperação de senha ou rotação de múltiplas chaves.

**Impacto:** logout remove o token do navegador, mas não invalida uma cópia já obtida. XSS pode acessar credenciais do navegador. O link compartilhado é bearer: qualquer destinatário pode repassá-lo. Código manual e QR são credenciais alternativas, não dois fatores.

**Decisão atual:** RBAC e ownership no servidor, algoritmos fixos, segredos separados, CSP, no-store, no-referrer e omissão de links bearer dos logs de requisição da API.

**Evolução:** autenticação para contas reais, estratégia de revogação e rotação, proteção de borda e revisão de logs das plataformas. A API não controla logs de acesso mantidos pelo proxy.

## Programação, volume e TMDb

**Limitação:** snapshots não acompanham alterações futuras da TMDb; busca de novos filmes depende do serviço externo. Listagens não têm paginação e salas são textos por sessão, sem agenda global que impeça sobreposição.

**Impacto:** o catálogo persistido permanece legível sem TMDb, mas grandes volumes encarecem consultas e renderização. Um organizador pode cadastrar horários conflitantes para uma sala. A grade do seed evita sobreposição, mas isso não é uma constraint do produto.

**Decisão atual:** escopo de catálogo pequeno, layout de até 200 lugares e até seis lugares por reserva. Métricas são agregadas em lote, sem consulta por sessão.

**Evolução:** paginação, entidade de sala e política de conflitos de agenda quando houver operação real com múltiplos organizadores. Medir consultas antes de adicionar cache ou índices especulativos.

## Seed e retenção

**Limitação:** o seed renova datas e senhas demo e pode restaurar o ingresso demonstrativo usado, se sua alocação ainda estiver ativa. Ele não apaga o histórico nem recompõe alocações liberadas. Não é reset completo ou migração de dados comerciais.

**Impacto:** executar seed em uma base em uso pode alterar o contexto temporal de compras e portaria. Registros históricos crescem sem política de retenção automática.

**Decisão atual:** seed manual, fora do restart/pre-deploy, e banco exclusivo para validação.

**Evolução:** separar fixtures de demonstração da carga operacional e definir retenção/anonimização com requisitos reais.

## Frontend e evidência de qualidade

**Limitação:** navegação do organizador é estado local, sem deep link para editor. Tipos de resposta e parte dos schemas OpenAPI são mantidos separadamente. Câmera depende de dispositivo, permissões e HTTPS; datas são exibidas no fuso do navegador.

**Impacto:** recarregar o organizador volta à lista; existe risco de divergência de contrato e horário para usuários em outro fuso. Testes axe em jsdom não medem contraste real, leitores de tela ou qualidade de câmera.

**Decisão atual:** testes comportamentais nos fluxos de maior risco, OpenAPI coberto, entrada manual e verificações explícitas de teclado/foco. Não há benchmark de carga nem percentual de cobertura publicado.

**Evolução:** roteamento do organizador com preservação de formulário, geração de contratos se a duplicação se tornar onerosa, apresentação explícita do fuso do cinema e auditoria com tecnologias assistivas/dispositivos reais.
