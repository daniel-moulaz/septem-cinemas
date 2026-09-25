# SEPTEM Cinemas

Sistema completo de gerenciamento, venda e operação de sessões de cinema. Projeto independente de portfólio de **Daniel Moulaz**.

[![CI](https://github.com/daniel-moulaz/septem-cinemas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/daniel-moulaz/septem-cinemas/actions/workflows/ci.yml)

## Demo

- [Aplicação](https://septem-cinemas.vercel.app)
- [API / health](https://elite-dev-verzel-production.up.railway.app/health)
- [Swagger UI](https://elite-dev-verzel-production.up.railway.app/docs)

A API pode levar alguns segundos para iniciar. As páginas públicas recuperam falhas temporárias automaticamente e informam a espera. A versão publicada depende do último rollout; mudanças locais só chegam à demo depois de publicadas.

SEPTEM emite apenas a identidade atual, mas mantém validação retrocompatível dos contratos legítimos anteriores. Sessões autenticadas e QRs existentes preservam sua validade original; a renomeação não exige novo login nem reemissão de ingressos. Veja a política de transição no [runbook](docs/OPERATIONS.md).

Todas as contas demonstrativas usam `Demo@123`:

| Papel | E-mail | Experimente |
|---|---|---|
| Cliente | `customer1@demo.local` | Programação → horário → assentos → reserva → pagamento simulado → ingresso |
| Cliente | `customer2@demo.local` | Ingresso semeado de Matrix, assento A1 |
| Organizador | `organizer@demo.local` | Criar, editar, publicar, duplicar e acompanhar sessões |
| Portaria | `gate@demo.local` | Validar QR ou código manual, com consumo único |

O seed prepara 14 sessões publicadas, dois rascunhos e um ingresso válido. Datas são relativas à execução do seed; não se renovam sozinhas. A base pública é compartilhada e pode ter sido alterada por outras pessoas.

## O que o sistema resolve

**Cliente:** programação por filme, data e cinema, reserva de até seis lugares com hold de dez minutos, checkout simulado, ingresso digital, compartilhamento sem dados pessoais e cancelamento elegível.

**Organizador:** snapshot de filmes da TMDb, edição segura de sessões publicadas, duplicação apenas da estrutura e métricas de capacidade, ocupação e receita simulada vigente.

**Portaria:** câmera com entrada manual alternativa e resultados `VALID`, `ALREADY_USED`, `WRONG_EVENT` e `INVALID`. O servidor impede consumo duplo mesmo com dispositivos concorrentes.

![Programação SEPTEM](docs/screenshots/home.png)

## Arquitetura e destaques técnicos

```text
React / Vite → Fastify → PostgreSQL
                  └──→ TMDb (somente pelo backend)
```

Monorepo com `@septem/web` e `@septem/api`, backend modular e PostgreSQL como autoridade transacional.

- **Concorrência:** locks ordenados, revalidação na transação e índice único parcial para alocações ativas. A [prova por mutação](docs/CONCURRENCY-PROOF.md) demonstra qual teste detecta a ausência de cada proteção.
- **Histórico preservado:** cancelamento e expiração liberam alocações sem apagar pagamentos ou ingressos.
- **Autorização:** JWT, Argon2id, RBAC e ownership no backend; recursos de outro cliente retornam `404`.
- **Ingresso:** QR assinado com HS256, consumo condicional atômico e links bearer com apenas o hash persistido.
- **Tempo real:** SSE sinaliza invalidações após commit; o cliente reconsulta o estado e mantém polling de recuperação.
- **Qualidade:** PostgreSQL real, testes comportamentais React, verificações axe, lint, typecheck e build na CI.
- **Operação:** logs estruturados, healthcheck, migrations em pre-deploy e OpenAPI executável.

## Stack

React 19, TypeScript, Vite, Fastify 5, Prisma 7 e PostgreSQL 17. Vitest, Testing Library e axe-core nos testes; ZXing e qrcode.react na jornada de ingresso; Docker Compose, GitHub Actions, Vercel e Railway na execução.

## Rodando localmente

Requer Node.js `^22.12.0` ou `^24.0.0`, npm e Docker.

```bash
cp .env.example .env
npm ci
npm run prisma:generate
npm run db:up
npm run db:migrate:deploy
npm run db:seed
npm run dev
```

No PowerShell, use `Copy-Item .env.example .env`. Frontend: `http://localhost:5173`; API: `http://localhost:3333`; Swagger: `http://localhost:3333/docs`.

Configure `JWT_SECRET` e `TICKET_SIGNING_SECRET` com valores aleatórios diferentes, de pelo menos 32 caracteres. `TMDB_READ_ACCESS_TOKEN` permite buscar novos filmes; sessões já persistidas funcionam sem ele. Somente `VITE_API_URL` é pública. `WEB_ORIGIN` é a origem exata do frontend. Não adicione `VITE_` aos segredos.

`npm run db:stop` para o banco preservando o volume. Para instalações locais anteriores, consulte o [runbook](docs/OPERATIONS.md).

## Testes

```bash
npm run check
npm run test:concurrency-proof
```

`check` valida Prisma, lint (inclusive scripts e testes), tipos, suítes API/web e builds. A suíte da API requer banco local migrado e semeado; use um banco exclusivo de teste. A prova cria e remove seu próprio banco no servidor indicado explicitamente por `DATABASE_URL`, exigindo permissão `CREATEDB`. A CI executa ambos em PostgreSQL descartável.

A contagem e as evidências estão no [relatório de hardening](docs/HARDENING-REPORT.md). Não há percentual de cobertura nem benchmark de carga publicado. Testes axe em jsdom não medem contraste renderizado nem substituem leitores de tela.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Decisões e ADR de idempotência](docs/DECISIONS.md)
- [Prova de concorrência](docs/CONCURRENCY-PROOF.md)
- [Limitações conhecidas](docs/KNOWN-LIMITATIONS.md)
- [Operação e diagnóstico](docs/OPERATIONS.md)
- [Requisitos](docs/REQUIREMENTS.md)
- [Uso de IA](docs/AI-USAGE.md)

O pagamento é simulado. SSE e limitação de login têm estado por processo. Integração financeira, refund e revogação imediata de JWT permanecem fora do escopo; veja as [limitações conhecidas](docs/KNOWN-LIMITATIONS.md).

## TMDb

Este produto usa a API da TMDb, mas não é endossado nem certificado pela TMDb. Pôsteres, backdrops e metadados pertencem a seus detentores de direitos.
