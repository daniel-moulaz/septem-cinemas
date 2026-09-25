# Requisitos do Produto

## Escopo e fontes

O SEPTEM Cinemas é uma plataforma focada exclusivamente em cinema, utilizando a TMDb como catálogo externo e priorizando um fluxo simples, completo e reproduzível.

Fluxo principal: o organizador escolhe um filme e publica uma sessão; o cliente encontra a sessão, reserva um assento, realiza um pagamento simulado e recebe um ingresso; antes da sessão, pode cancelar a compra elegível inteira e devolver os lugares; a portaria valida e consome ingressos ativos por QR Code ou código manual.

## Requisitos funcionais P0

### Acesso e papéis

- Autenticar contas de demonstração por e-mail e senha.
- Aplicar no backend os papéis `ORGANIZER`, `CUSTOMER` e `GATE`.
- Verificar ownership: organizadores acessam somente suas sessões e clientes somente seus ingressos e reservas.

### Organizador e catálogo

- Pesquisar filmes da TMDb por meio do backend, sem expor a chave ao navegador.
- Criar e editar uma sessão em rascunho com filme, data e hora, local/sala, preço e mapa de assentos.
- Salvar um snapshot dos dados relevantes do filme ao criar a sessão.
- Publicar e listar as próprias sessões.
- Permitir editar uma sessão publicada enquanto a alteração for comprovadamente segura: sem hold ativo, sem compra paga, sem nenhum ingresso emitido e antes do início. A sessão permanece `PUBLISHED` e preserva `publishedAt`.
- Bloquear a edição assim que existir consequência comercial, informando o motivo real derivado pelo backend, e impedir a reconstrução do mapa quando houver histórico de alocação de assentos.
- Exibir métricas operacionais reais da sessão: capacidade, disponíveis, holds ativos, vendidos, ocupação e receita simulada vigente.
- Duplicar uma sessão como novo rascunho, copiando apenas a estrutura e nunca dados transacionais.

### Cliente, reserva e pagamento

- Listar sessões publicadas, realizar busca textual básica e abrir seus detalhes.
- Exibir um mapa com assentos disponíveis, ocupados e temporariamente reservados.
- Atualizar o mapa aberto sem recarregar a página quando outro cliente reservar ou liberar um lugar, mantendo o PostgreSQL como fonte de verdade e sem depender do canal em tempo real para a correção.
- Criar um hold de 10 minutos para os assentos escolhidos.
- Expirar holds de forma lazy e atômica, sem cron ou job.
- Impedir no PostgreSQL que duas reservas mantenham simultaneamente uma alocação ativa para o mesmo assento.
- Simular pagamentos com resultados reproduzíveis `APPROVED` e `DECLINED`, usando sempre o preço calculado pelo backend.
- Emitir ingresso somente quando o pagamento for aprovado; uma recusa cancela a reserva e libera o hold.
- Listar “Meus ingressos” e exibir ingresso digital com QR Code e código manual.
- Permitir ao cliente cancelar a reserva `PAID` própria inteira antes do início da sessão, desde que ainda não esteja cancelada e nenhum ingresso da compra esteja `USED`.
- Permitir ao cliente cancelar um ingresso `VALID` individual da própria compra, sem afetar os demais ingressos ainda válidos da mesma reserva.
- No cancelamento — individual ou da compra inteira —, mover o(s) ingresso(s) ainda `VALID` para `CANCELLED`, liberar imediatamente o(s) assento(s) correspondente(s) e preservar `Payment`, `Ticket` e `ReservationSeat` como histórico. A reserva só passa a `CANCELLED` quando todos os ingressos foram cancelados; `USED` mantém a compra paga. Não simular refund financeiro.

### Compartilhamento e portaria

- Criar um link bearer em `/shared/:token` com token aleatório forte; persistir somente seu hash.
- Exibir no link apenas os dados necessários do ingresso, com `Cache-Control: no-store`, sem transferir sua propriedade.
- Exibir um ingresso cancelado como `CANCELLED`, com `manualCode` e `qrToken` nulos, inclusive em link compartilhado já existente; impedir a criação de novo link para ele.
- Permitir que a portaria selecione uma sessão, leia o QR pela câmera ou informe o código manual.
- Retornar de forma inequívoca `VALID`, `INVALID`, `ALREADY_USED` ou `WRONG_EVENT`.
- Tratar qualquer credencial de ingresso `CANCELLED` como `INVALID`, inclusive na corrida entre Gate e cancelamento.
- Consumir o ingresso atomicamente, permitindo somente um sucesso em validações concorrentes.

### Entrega

- Disponibilizar dados de demonstração para os três papéis e ao menos uma sessão publicada.
- Publicar frontend, API e PostgreSQL. O deploy permite experimentar as três jornadas.
- Documentar instalação, credenciais fictícias, cenários de pagamento, arquitetura, limitações e uso de IA no README final.

## Requisitos não funcionais

- Usar React, TypeScript e Vite no frontend; Node.js, TypeScript e Fastify no backend; PostgreSQL e Prisma na persistência.
- Validar entradas externas, armazenar senhas com hash apropriado e manter secrets somente em variáveis de ambiente.
- Implementar loading, empty state, feedback de sucesso e erros compreensíveis nas jornadas principais.
- Oferecer interface responsiva, acessibilidade básica e identidade visual ligada a cinema e ingresso digital.
- Cobrir por integração autenticação, RBAC/ownership, concorrência de assentos, pagamentos, emissão, cancelamento, adulteração e consumo do ingresso.
- Manter verificações reproduzíveis, contratos seguros e complexidade proporcional ao produto.

## Fora de escopo

- Shows, pista ou múltiplos tipos de evento.
- Pagamento financeiro real, reembolso, revenda, nota fiscal ou envio de ingresso por e-mail. O cancelamento preserva o pagamento aprovado como histórico e não representa estorno.
- Recuperação de senha, aplicativo nativo e transferência de titularidade.
- Redis, filas, microsserviços ou arquitetura orientada a eventos.

## Critérios essenciais de aceite

1. Dois clientes disputando o mesmo assento resultam em, no máximo, um hold ativo.
2. Hold expirado é liberado atomicamente antes de nova reserva ou pagamento.
3. Pagamento aprovado cria ingresso; pagamento recusado nunca cria ingresso válido.
4. QR adulterado falha, mesmo que contenha um identificador existente.
5. Duas validações simultâneas do mesmo ingresso geram um único `VALID`.
6. Um ingresso de outra sessão resulta em `WRONG_EVENT` e não é consumido.
7. O link compartilhado não é armazenado em texto puro nem pode ser cacheado.
8. As jornadas dos três papéis funcionam no deploy e com os dados de demonstração.
9. Cancelar uma compra futura `PAID` própria e sem ingresso usado cancela todos os ingressos, preserva o pagamento e permite que outro cliente reserve os assentos liberados.
10. Compra alheia, sessão iniciada, ingresso usado e segundo cancelamento são rejeitados sem alteração parcial.
11. Em Gate × cancelamento concorrentes, somente uma transição vence: acesso concedido mantém a compra; cancelamento concluído torna a credencial `INVALID`.
12. Cancelar um ingresso individual de uma compra com múltiplos assentos afeta somente aquele ingresso e seu assento; os demais ingressos e assentos da mesma compra permanecem válidos e vendidos, e a reserva só passa a `CANCELLED` quando o último ingresso `VALID` é cancelado.
13. Uma sessão publicada sem hold ativo, compra paga ou ingresso emitido pode ter filme, horário, local, preço e layout alterados, permanecendo `PUBLISHED`; assim que existir qualquer um desses estados, a edição é recusada com o motivo real.
14. Uma reserva concorrente a uma edição nunca é criada sobre preço ou layout obsoletos: ou a edição espera e é recusada pelo hold, ou a reserva espera e usa a estrutura nova.
15. Duplicar uma sessão cria um rascunho com assentos novos e sem nenhuma reserva, alocação, pagamento, ingresso ou link compartilhado.
