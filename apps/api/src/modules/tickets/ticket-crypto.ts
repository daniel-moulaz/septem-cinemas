import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const TICKET_TOKEN_ISSUER = 'septem-cinemas-api'
export const TICKET_TOKEN_AUDIENCE = 'septem-cinemas-gate'
export const TICKET_TOKEN_TYPE = 'ticket'
export const TICKET_TOKEN_VERSION = 1
export const TICKET_TOKEN_ALGORITHM = 'HS256'
export const TICKET_RUNTIME_FALLBACK_MINUTES = 180
export const TICKET_EXPIRATION_MARGIN_MINUTES = 120

const MANUAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const MANUAL_CODE_LENGTH = 16
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface TicketTokenClaims {
  iss: typeof TICKET_TOKEN_ISSUER
  aud: typeof TICKET_TOKEN_AUDIENCE
  typ: typeof TICKET_TOKEN_TYPE
  ver: typeof TICKET_TOKEN_VERSION
  jti: string
  sid: string
  iat: number
  exp: number
}

export interface SignTicketTokenInput {
  ticketId: string
  sessionId: string
  issuedAt: Date
  sessionStartsAt: Date
  movieRuntimeMinutes: number | null
  secret: string
}

interface VerifyTicketTokenOptions {
  secret: string
  now?: Date
}

function assertSigningSecret(secret: string) {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('O segredo de assinatura do ingresso é inválido.')
  }
}

function encodeJson(value: object) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function signEncodedValue(encodedValue: string, secret: string) {
  return createHmac('sha256', secret)
    .update(encodedValue)
    .digest('base64url')
}

function parseEncodedJson(encodedValue: string): unknown {
  return JSON.parse(Buffer.from(encodedValue, 'base64url').toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidClaims(value: unknown): value is TicketTokenClaims {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.iss === TICKET_TOKEN_ISSUER &&
    value.aud === TICKET_TOKEN_AUDIENCE &&
    value.typ === TICKET_TOKEN_TYPE &&
    value.ver === TICKET_TOKEN_VERSION &&
    typeof value.jti === 'string' &&
    UUID_PATTERN.test(value.jti) &&
    typeof value.sid === 'string' &&
    UUID_PATTERN.test(value.sid) &&
    typeof value.iat === 'number' &&
    typeof value.exp === 'number' &&
    Number.isInteger(value.iat) &&
    Number.isInteger(value.exp) &&
    value.exp > value.iat
  )
}

export function getTicketExpirationDate(
  sessionStartsAt: Date,
  movieRuntimeMinutes: number | null,
) {
  const runtimeMinutes =
    movieRuntimeMinutes ?? TICKET_RUNTIME_FALLBACK_MINUTES
  const validForMinutes =
    runtimeMinutes + TICKET_EXPIRATION_MARGIN_MINUTES

  return new Date(sessionStartsAt.getTime() + validForMinutes * 60_000)
}

export function signTicketToken(input: SignTicketTokenInput) {
  assertSigningSecret(input.secret)

  const header = {
    alg: TICKET_TOKEN_ALGORITHM,
    typ: 'JWT',
  }
  const expiresAt = getTicketExpirationDate(
    input.sessionStartsAt,
    input.movieRuntimeMinutes,
  )
  const claims: TicketTokenClaims = {
    iss: TICKET_TOKEN_ISSUER,
    aud: TICKET_TOKEN_AUDIENCE,
    typ: TICKET_TOKEN_TYPE,
    ver: TICKET_TOKEN_VERSION,
    jti: input.ticketId,
    sid: input.sessionId,
    iat: Math.floor(input.issuedAt.getTime() / 1_000),
    exp: Math.floor(expiresAt.getTime() / 1_000),
  }
  const encodedValue = `${encodeJson(header)}.${encodeJson(claims)}`

  return `${encodedValue}.${signEncodedValue(encodedValue, input.secret)}`
}

export function verifyTicketToken(
  token: string,
  options: VerifyTicketTokenOptions,
) {
  assertSigningSecret(options.secret)

  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new Error('Token de ingresso inválido.')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts

  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Token de ingresso inválido.')
  }

  let header: unknown
  let payload: unknown

  try {
    header = parseEncodedJson(encodedHeader)
    payload = parseEncodedJson(encodedPayload)
  } catch {
    throw new Error('Token de ingresso inválido.')
  }

  if (
    !isRecord(header) ||
    header.alg !== TICKET_TOKEN_ALGORITHM ||
    header.typ !== 'JWT'
  ) {
    throw new Error('Token de ingresso inválido.')
  }

  const encodedValue = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = Buffer.from(
    signEncodedValue(encodedValue, options.secret),
    'utf8',
  )
  const receivedSignature = Buffer.from(encodedSignature, 'utf8')

  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw new Error('Token de ingresso inválido.')
  }

  if (!isValidClaims(payload)) {
    throw new Error('Token de ingresso inválido.')
  }

  const nowInSeconds = Math.floor(
    (options.now ?? new Date()).getTime() / 1_000,
  )

  if (payload.exp <= nowInSeconds) {
    throw new Error('Token de ingresso expirado.')
  }

  return payload
}

function randomAlphabetCharacters(length: number) {
  let result = ''
  const alphabetLength = MANUAL_CODE_ALPHABET.length
  const unbiasedLimit = Math.floor(256 / alphabetLength) * alphabetLength

  while (result.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= unbiasedLimit) {
        continue
      }

      result += MANUAL_CODE_ALPHABET[byte % alphabetLength]!

      if (result.length === length) {
        break
      }
    }
  }

  return result
}

export function generateManualCode() {
  return randomAlphabetCharacters(MANUAL_CODE_LENGTH)
    .match(/.{1,4}/gu)!
    .join('-')
}
