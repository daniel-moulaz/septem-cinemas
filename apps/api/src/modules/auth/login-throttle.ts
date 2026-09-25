/**
 * Limite de abuso em `POST /auth/login`.
 *
 * A chave é **somente a origem da requisição**, nunca o e-mail. Uma versão
 * anterior usava `e-mail + origem` e verificava o bloqueio antes da conferência
 * da senha: como a senha correta também era recusada durante o cooldown,
 * qualquer pessoa podia manter uma conta conhecida indisponível enviando uma
 * tentativa errada por minuto. Com as credenciais de demonstração públicas,
 * isso seria uma negação de serviço trivial contra a demonstração.
 * Tirando a conta da chave, um cliente abusivo passa a limitar apenas a si
 * mesmo — não existe mais bloqueio direcionado a uma conta.
 *
 * O que isto protege, honestamente: a CPU do servidor. Cada tentativa custa um
 * hash Argon2id, e o bloqueio acontece antes dele. O que isto **não** é: uma
 * defesa contra adivinhação de senha das contas de demonstração, cujas
 * credenciais estão publicadas no README — para elas não há segredo a
 * proteger.
 *
 * `request.ip` só é o endereço real do cliente quando `TRUST_PROXY` está
 * ligado. Sem isso, atrás do proxy de uma plataforma todos os clientes
 * compartilham a mesma origem e o limite passa a valer para o conjunto. Por
 * isso o limiar é alto e o cooldown é curto: tráfego legítimo não chega perto
 * de vinte falhas em quinze minutos, e o pior caso é um minuto.
 *
 * O estado é em memória, igual ao broadcaster do SSE (ADR-021): a topologia é
 * de instância única. Com múltiplas réplicas o limite vale por processo, o que
 * ainda reduz a taxa efetiva, mas deixa de ser global. Um limite compartilhado
 * exigiria Redis, infraestrutura que este deploy não justifica.
 */

const WINDOW_MILLISECONDS = 15 * 60 * 1_000
const MAX_FAILED_ATTEMPTS = 20
const COOLDOWN_MILLISECONDS = 60 * 1_000

/**
 * Teto defensivo do mapa. Sem ele, um atacante variando a origem a cada
 * tentativa transformaria a proteção em um vazamento de memória.
 */
const MAX_TRACKED_KEYS = 10_000

interface AttemptWindow {
  failures: number[]
}

const attemptsByKey = new Map<string, AttemptWindow>()

/**
 * A chave é a origem, e nada mais. Incluir o e-mail permitiria bloquear a
 * conta de outra pessoa de propósito.
 */
export function loginThrottleKey(clientIp: string) {
  return clientIp
}

function activeFailures(window: AttemptWindow, now: number) {
  const cutoff = now - WINDOW_MILLISECONDS

  return window.failures.filter((timestamp) => timestamp > cutoff)
}

function pruneExpired(now: number) {
  for (const [key, window] of attemptsByKey) {
    const remaining = activeFailures(window, now)

    if (remaining.length === 0) {
      attemptsByKey.delete(key)
      continue
    }

    window.failures = remaining
  }
}

/**
 * Segundos que faltam para a chave voltar a aceitar tentativas, ou `null`
 * quando ela ainda está dentro do limite.
 */
export function loginRetryAfterSeconds(
  key: string,
  now: number = Date.now(),
): number | null {
  const window = attemptsByKey.get(key)

  if (!window) {
    return null
  }

  const failures = activeFailures(window, now)
  window.failures = failures

  if (failures.length < MAX_FAILED_ATTEMPTS) {
    return null
  }

  const latest = failures[failures.length - 1]

  if (latest === undefined) {
    return null
  }

  const releasesAt = latest + COOLDOWN_MILLISECONDS

  if (releasesAt <= now) {
    return null
  }

  return Math.max(1, Math.ceil((releasesAt - now) / 1_000))
}

export function registerFailedLogin(key: string, now: number = Date.now()) {
  if (attemptsByKey.size >= MAX_TRACKED_KEYS) {
    pruneExpired(now)
  }

  if (attemptsByKey.size >= MAX_TRACKED_KEYS && !attemptsByKey.has(key)) {
    // Sob pressão extrema, prefere-se não rastrear a nova chave a crescer sem
    // limite. As chaves já sob ataque continuam protegidas.
    return
  }

  const window = attemptsByKey.get(key) ?? { failures: [] }

  window.failures = [...activeFailures(window, now), now]
  attemptsByKey.set(key, window)
}

export function clearFailedLogins(key: string) {
  attemptsByKey.delete(key)
}

/** Usado apenas pelos testes, para isolar cenários entre casos. */
export function resetLoginThrottle() {
  attemptsByKey.clear()
}

export const loginThrottleLimits = {
  maxFailedAttempts: MAX_FAILED_ATTEMPTS,
  windowMilliseconds: WINDOW_MILLISECONDS,
  cooldownMilliseconds: COOLDOWN_MILLISECONDS,
}
