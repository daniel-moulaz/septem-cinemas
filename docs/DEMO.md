# Conheça o SEPTEM

[Abrir aplicação](https://septem-cinemas.vercel.app) · [Voltar ao README](../README.md)

O SEPTEM cobre três perspectivas de uma sessão de cinema: quem reserva um lugar, quem organiza a sessão e quem valida o ingresso na portaria. O pagamento é simulado.

As telas abaixo já fazem parte da documentação do projeto e mostram contas e sessões demonstrativas. As datas das capturas não indicam disponibilidade atual. A base online é compartilhada; uma sessão ou um ingresso de exemplo pode ter sido alterado por outra pessoa.

## Programação demonstrativa

Em **15/10/2026**, foram adicionadas **40 sessões** na mostra **SEPTEM Mostra Demo**, de **24/10/2026 a 23/10/2027**. Cada data tem Cidade de Deus, Matrix, Interestelar, Duna: Parte Dois e O Poderoso Chefão, em salas diferentes.

| Datas | Horários de Brasília |
| --- | --- |
| 24/10/2026 · 21/11/2026 · 16/01/2027 · 20/03/2027 · 22/05/2027 · 24/07/2027 · 18/09/2027 · 23/10/2027 | Cidade de Deus 14h · Matrix 16h · Interestelar 18h · Duna: Parte Dois 20h · O Poderoso Chefão 21h |

São sessões fictícias para explorar a aplicação, sem exibição presencial nem cobrança real. A listagem pública confirmou as 40 novas sessões, com IDs distintos; os dados de cadastro das 53 sessões anteriores foram preservados. Foram duplicadas somente estruturas, sem reexecutar seed ou copiar reservas e ingressos.

As datas são fixas, sem renovação automática. Confira a programação online para a disponibilidade atual.

## 1. Escolher a sessão e os lugares

Na [programação](https://septem-cinemas.vercel.app), abra um filme com horário futuro, selecione os assentos e entre com a conta de cliente descrita no [README](../README.md#demo). Uma reserva mantém os lugares por dez minutos; o checkout demonstrativo emite o ingresso.

![Mapa de assentos com dois lugares selecionados e resumo da reserva](screenshots/seat-map.png)

**Decisão técnica:** disponibilidade na tela é uma consulta. A confirmação acontece em uma transação no PostgreSQL, com revalidação, locks e índice único parcial. Veja a [prova de concorrência](CONCURRENCY-PROOF.md), incluindo o que ela demonstra e seus limites.

## 2. Acompanhar a operação

Com a conta de organizador, consulte as sessões e seus indicadores. A duplicação copia a estrutura para um novo rascunho, sem copiar reservas, pagamentos ou ingressos. A publicação é uma ação separada.

![Visão do organizador com capacidade, ocupação e receita simulada da sessão](screenshots/organizer.png)

**Decisão técnica:** mudanças estruturais são revalidadas no servidor. O histórico de uma compra não depende de um formulário continuar desabilitado no navegador. [Arquitetura](ARCHITECTURE.md) · [Testes de edição](../apps/api/tests/session-editability.integration.test.ts) · [Testes de duplicação](../apps/api/tests/session-duplication.integration.test.ts).

## 3. Validar a entrada

Na portaria, selecione a sessão e leia o QR ou use o código manual. O primeiro uso válido consome o ingresso; uma nova tentativa retorna `ALREADY_USED`.

![Portaria demonstrativa mostrando um ingresso válido e consumido](screenshots/gate-valid.png)

**Decisão técnica:** o consumo é condicional e atômico no banco. Não basta guardar o resultado no dispositivo de quem escaneou. [Testes de portaria](../apps/api/tests/gate.integration.test.ts).

## Se a programação estiver vazia

A listagem pública mostra sessões futuras publicadas. Os dados do seed têm datas relativas ao momento em que ele é executado e não são renovados automaticamente. Para explorar por conta própria, use o [ambiente local](../README.md#rodando-localmente).

Na base compartilhada, novas datas devem ser criadas pelo organizador, duplicando somente a estrutura de uma sessão e publicando a cópia. Reexecutar o seed pode mudar datas e credenciais demonstrativas, por isso não é um mecanismo de manutenção da programação em uso.

## Limites da demonstração

- Não há cobrança financeira real.
- A API hospedada pode ter inicialização lenta ou indisponibilidade temporária.
- O catálogo e a programação dependem dos dados cadastrados.
- As capturas documentam fluxos; não substituem testes da versão atualmente publicada.

[Limitações conhecidas](KNOWN-LIMITATIONS.md) · [Como executar os testes](../README.md#testes) · [CI](https://github.com/daniel-moulaz/septem-cinemas/actions/workflows/ci.yml)
