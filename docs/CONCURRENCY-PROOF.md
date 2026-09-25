# Prova de concorrência

## Cenário e garantias

Dois clientes tentam reservar A7 na mesma sessão. A transação primeiro lê a sessão sob `FOR SHARE`, excluindo edição estrutural concorrente (`FOR UPDATE`). Depois bloqueia assentos por ID crescente, reservas relacionadas por ID crescente e revalida estado e expiração usando `clock_timestamp()` do PostgreSQL. A criação e suas alocações são confirmadas juntas; falha de inserção reverte a reserva.

A ordem global das operações é `Session → Seat → Reservation → ReservationSeat → Ticket`, omitindo entidades que uma operação não precisa bloquear. A portaria altera Ticket condicionalmente; não adquire depois locks anteriores na ordem. Não há promessa de ausência universal de deadlocks: a disciplina e os cenários conhecidos são cobertos por testes.

O índice SQL `ReservationSeat_active_seatId_key`, com predicado `releasedAt IS NULL`, impede duas alocações ativas por assento. Alocações liberadas permanecem como histórico. Ele está na migration `20260820120500_add_releasable_reservation_seats`, não como unicidade global no Prisma Client.

## O que o teste observa

Em `reservations.integration.test.ts`, uma conexão independente mantém A7 bloqueado. Duas requisições HTTP são iniciadas. Uma terceira conexão consulta `pg_stat_activity` até observar duas consultas de assentos em `wait_event_type = 'Lock'`. Só então a conexão bloqueadora confirma sua transação.

O teste exige respostas `201` e `409 SEAT_UNAVAILABLE`, uma única reserva e uma única alocação. O vencedor não é predeterminado. A barreira comprova sobreposição real das requisições no banco; os intervalos de consulta apenas observam a condição, não presumem que uma corrida aconteceu após dormir. O prazo de cinco segundos é um guard de falha.

Outro teste tenta inserir uma segunda alocação pelo Prisma, contornando os locks do serviço. Exige `P2002` e nenhuma reserva órfã. Isso testa a defesa do banco independentemente do caminho HTTP.

## Mutation proof reproduzível

```bash
npm run prisma:generate
npm run test:concurrency-proof
```

Defina `DATABASE_URL` explicitamente para um PostgreSQL local; a conexão precisa poder criar bancos. O script não lê `.env`. No PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://septem:local_development_only@127.0.0.1:5432/septem_cinemas?schema=public'
npm run test:concurrency-proof
```

O runner copia a API para um diretório temporário, compartilha somente dependências e cria um banco `septem_proof_<uuid>`. Aplica migrations e seed. Os arquivos de trabalho nunca são alterados, portanto uma árvore com mudanças locais é segura. A mutação usa o código atual copiado, não um modelo simplificado da regra.

| Etapa | Resultado exigido | O que demonstra |
|---|---|---|
| Controle com as duas proteções | Ambos os testes passam | Ambiente e fixtures funcionam antes das mutações |
| A: remover `FOR UPDATE` da consulta de Seat | O teste falha na observação da espera | Detecta perda de coordenação; não afirma que remover só o lock causa venda dupla |
| Só locks, sem índice parcial | A disputa HTTP ainda passa | O teste HTTP sozinho não prova a existência da defesa final |
| B: remover o índice parcial | A tentativa direta de duplicação resolve e a asserção que exigia rejeição falha | O teste detecta perda da unicidade no banco |
| Controle restaurado | Ambos passam novamente | Confirma a restauração das proteções no ambiente de prova |

O runner inspeciona o relatório JSON do Vitest: precisa ser exatamente o teste esperado, com a mensagem esperada. Um erro de configuração, importação, autenticação ou banco indisponível não conta como mutação detectada. O script retorna erro nessas situações.

O banco e a cópia são removidos em `finally`; SIGINT/SIGTERM cancelam o subprocesso e acionam a limpeza. Encerramento forçado do sistema pode deixar resíduos temporários: nenhum mecanismo de finally resiste a SIGKILL ou queda de energia. O runbook explica como identificar resíduos. Nunca se remove constraint do banco de desenvolvimento ou produção.

## Defesa em profundidade e limites

As suítes de edição, pagamento, cancelamento, portaria e SSE cobrem outras invariantes: preço revalidado sob lock, rollback, liberação auditável, Gate versus cancelamento, consumo único e ausência de evento antes do commit. A mutation proof tem escopo restrito às duas proteções de reserva descritas acima. Ela não é um mutation score geral nem um teste de carga e não prova todos os interleavings possíveis.

SSE não participa da decisão de quem recebe o assento. É apenas invalidação pós-commit. A disponibilidade definitiva sempre vem do PostgreSQL.
