process.env.NODE_ENV = 'test'
process.env.API_HOST ??= '127.0.0.1'
process.env.API_PORT ??= '3333'
process.env.DATABASE_URL ??=
  'postgresql://septem:local_development_only@localhost:5432/septem_cinemas?schema=public'
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('A suíte de testes exige um PostgreSQL local; bancos remotos são recusados.')
}
process.env.WEB_ORIGIN ??= 'http://localhost:5173'
process.env.JWT_SECRET ??=
  'test_only_secret_that_must_never_be_used_in_production'
process.env.TICKET_SIGNING_SECRET ??=
  'test_only_ticket_secret_that_must_never_be_used_in_production'
