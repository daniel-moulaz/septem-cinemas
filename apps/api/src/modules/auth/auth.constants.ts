export const AUTH_TOKEN_ISSUER = 'septem-cinemas-api'
export const AUTH_TOKEN_AUDIENCE = 'septem-cinemas-web'
export const AUTH_TOKEN_DURATION = '8h'

// Acceptance only. Signing always uses the SEPTEM constants above.
export function isAuthTokenContract(issuer: unknown, audience: unknown) {
  return (
    (issuer === AUTH_TOKEN_ISSUER && audience === AUTH_TOKEN_AUDIENCE) ||
    (issuer === 'elite-dev-verzel-api' && audience === 'elite-dev-verzel-web')
  )
}
