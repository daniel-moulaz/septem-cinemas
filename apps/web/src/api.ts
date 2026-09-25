import { publicRead } from './public-read'

export type Role = 'ORGANIZER' | 'CUSTOMER' | 'GATE'

export interface AuthenticatedUser {
  id: string
  name: string
  email: string
  role: Role
}

export interface CatalogMovie {
  id: number
  title: string
  overview: string | null
  posterPath: string | null
  backdropPath: string | null
  releaseDate: string | null
  runtimeMinutes?: number | null
}

export interface SessionMovie {
  tmdbId: number
  title: string
  overview: string | null
  posterPath: string | null
  backdropPath: string | null
  releaseDate: string | null
  runtimeMinutes: number | null
}

export type SessionStatus = 'DRAFT' | 'PUBLISHED'

export type SessionEditabilityReason =
  | 'DRAFT'
  | 'PUBLISHED_SAFE'
  | 'SESSION_STARTED'
  | 'ACTIVE_HOLD'
  | 'COMMERCIAL_HISTORY'

/**
 * Política derivada pelo backend. O frontend apenas apresenta o que vem daqui;
 * a autoridade sobre editar ou não é sempre do servidor.
 */
export interface SessionEditability {
  allowed: boolean
  reason: SessionEditabilityReason
  layoutEditable: boolean
}

/** Métricas operacionais calculadas pelo backend. Sem dados pessoais. */
export interface SessionMetrics {
  capacity: number
  availableSeats: number
  heldSeats: number
  soldSeats: number
  occupancyPercentage: number
  simulatedRevenueCents: number
}

export interface OrganizerSession {
  id: string
  status: SessionStatus
  startsAt: string
  venueName: string
  roomName: string
  address: string
  priceCents: number
  publishedAt: string | null
  capacity: number
  rows: number
  seatsPerRow: number
  movie: SessionMovie
  editability: SessionEditability
  metrics: SessionMetrics
}

export interface SessionInput {
  tmdbMovieId: number
  startsAt: string
  venueName: string
  roomName: string
  address: string
  priceCents: number
  rows: number
  seatsPerRow: number
}

export type SessionUpdateInput = Partial<SessionInput>

export interface PublicSessionSummary {
  id: string
  startsAt: string
  venueName: string
  roomName: string
  priceCents: number
  capacity: number
  movie: {
    tmdbId: number
    title: string
    posterPath: string | null
    backdropPath: string | null
    releaseDate: string | null
    runtimeMinutes: number | null
  }
}

export interface PublicSessionDetail extends PublicSessionSummary {
  address: string
  movie: SessionMovie
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD'

export interface SessionSeat {
  id: string
  label: string
  rowLabel: string
  number: number
  status: SeatStatus
}

export type ReservationStatus =
  | 'PENDING'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'

export interface Reservation {
  id: string
  status: ReservationStatus
  expiresAt: string
  totalCents: number
  session: {
    id: string
    startsAt: string
    venueName: string
    roomName: string
    movie: {
      title: string
      posterPath: string | null
    }
  }
  seats: Array<{
    id: string
    label: string
    unitPriceCents: number
  }>
}

export type PaymentStatus = 'APPROVED' | 'DECLINED'

export interface PaymentResult {
  payment: {
    id: string
    status: PaymentStatus
    amountCents: number
    createdAt: string
  }
  reservation: {
    id: string
    status: Extract<ReservationStatus, 'PAID' | 'CANCELLED'>
  }
  tickets: Array<{ id: string }>
}

export type TicketStatus = 'VALID' | 'USED' | 'CANCELLED'

export interface TicketReservation {
  id: string
  status: Extract<ReservationStatus, 'PAID' | 'CANCELLED'>
  ticketCount: number
  canCancel: boolean
}

export interface TicketSummary {
  id: string
  status: TicketStatus
  manualCode: string | null
  issuedAt: string
  canCancel: boolean
  reservation: TicketReservation
  seat: {
    id: string
    label: string
  }
  session: {
    id: string
    startsAt: string
    venueName: string
    roomName: string
    movie: {
      title: string
      posterPath: string | null
    }
  }
}

export interface TicketDetail extends TicketSummary {
  qrToken: string | null
  session: TicketSummary['session'] & {
    address: string
  }
  shareLink: {
    expiresAt: string
  } | null
}

export interface SharedTicket {
  id: string
  status: TicketStatus
  manualCode: string | null
  issuedAt: string
  qrToken: string | null
  seat: {
    label: string
  }
  session: {
    startsAt: string
    venueName: string
    roomName: string
    address: string
    movie: {
      title: string
      posterPath: string | null
    }
  }
}

export interface ShareLinkResult {
  url: string
  expiresAt: string
}

export interface ReservationCancellationResult {
  reservation: {
    id: string
    status: Extract<ReservationStatus, 'CANCELLED'>
  }
  tickets: Array<{
    id: string
    status: Extract<TicketStatus, 'CANCELLED'>
  }>
}

export interface TicketCancellationResult {
  ticket: {
    id: string
    status: Extract<TicketStatus, 'CANCELLED'>
  }
  reservation: {
    id: string
    status: Extract<ReservationStatus, 'PAID' | 'CANCELLED'>
  }
}

export interface GateSession {
  id: string
  startsAt: string
  venueName: string
  roomName: string
  movie: {
    title: string
    posterPath: string | null
  }
}

export type GateConsumeResult =
  | { result: 'INVALID' | 'WRONG_EVENT' }
  | { result: 'ALREADY_USED'; usedAt: string | null }
  | {
      result: 'VALID'
      usedAt: string
      ticket: {
        seat: { label: string }
        session: {
          id: string
          startsAt: string
          venueName: string
          roomName: string
          movie: { title: string }
        }
      }
    }

interface LoginResponse {
  accessToken: string
  user: AuthenticatedUser
}

interface MoviesResponse {
  movies: CatalogMovie[]
}

interface SessionsResponse {
  sessions: OrganizerSession[]
}

interface PublicSessionsResponse {
  sessions: PublicSessionSummary[]
}

interface SeatsResponse {
  sessionId: string
  seats: SessionSeat[]
}

interface TicketsResponse {
  tickets: TicketSummary[]
}

interface GateSessionsResponse {
  sessions: GateSession[]
}

interface ErrorResponse {
  message?: unknown
  error?: unknown
}

const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3333').replace(
  /\/+$/,
  '',
)

/**
 * URL do stream SSE de uma sessão. Os eventos são apenas sinais de
 * invalidação: o estado dos assentos continua vindo de `getSessionSeats`.
 */
export function sessionEventsUrl(sessionId: string): string {
  return `${apiUrl}/sessions/${encodeURIComponent(sessionId)}/events`
}

let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch((error: unknown) => {
    if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) throw error
    return null
  })

  if (!response.ok) {
    const errorBody = body as ErrorResponse | null
    const message =
      typeof errorBody?.message === 'string'
        ? errorBody.message
        : 'Não foi possível concluir a solicitação.'
    const code =
      typeof errorBody?.error === 'string' ? errorBody.error : undefined

    throw new ApiError(message, response.status, code)
  }

  if (body === null && response.status !== 204) {
    throw new ApiError('O servidor retornou uma resposta inválida.', 502)
  }
  return body as T
}

async function publicRequest<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  return publicRead(`${apiUrl}${path}`, readResponse<T>, signal)
}

async function authenticatedRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)

  if (init.body) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  })

  if (response.status === 401) {
    unauthorizedHandler?.()
  }

  return readResponse<T>(response)
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  return readResponse<LoginResponse>(response)
}

export function getCurrentUser(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AuthenticatedUser> {
  return authenticatedRequest<AuthenticatedUser>('/auth/me', accessToken, {
    signal: signal ?? null,
  })
}

export function getCatalogMovies(
  accessToken: string,
  query = '',
  signal?: AbortSignal,
): Promise<MoviesResponse> {
  const params = new URLSearchParams()
  const normalizedQuery = query.trim()

  if (normalizedQuery) {
    params.set('q', normalizedQuery)
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : ''

  return authenticatedRequest<MoviesResponse>(
    `/catalog/movies${suffix}`,
    accessToken,
    { signal: signal ?? null },
  )
}

export function getCatalogMovie(
  accessToken: string,
  tmdbId: number,
  signal?: AbortSignal,
): Promise<CatalogMovie> {
  return authenticatedRequest<CatalogMovie>(
    `/catalog/movies/${tmdbId}`,
    accessToken,
    { signal: signal ?? null },
  )
}

export async function getOrganizerSessions(
  accessToken: string,
  signal?: AbortSignal,
): Promise<OrganizerSession[]> {
  const response = await authenticatedRequest<SessionsResponse>(
    '/organizer/sessions',
    accessToken,
    { signal: signal ?? null },
  )

  return response.sessions
}

export function getOrganizerSession(
  accessToken: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<OrganizerSession> {
  return authenticatedRequest<OrganizerSession>(
    `/organizer/sessions/${sessionId}`,
    accessToken,
    { signal: signal ?? null },
  )
}

export function createOrganizerSession(
  accessToken: string,
  input: SessionInput,
): Promise<OrganizerSession> {
  return authenticatedRequest<OrganizerSession>(
    '/organizer/sessions',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export function updateOrganizerSession(
  accessToken: string,
  sessionId: string,
  input: SessionUpdateInput,
): Promise<OrganizerSession> {
  return authenticatedRequest<OrganizerSession>(
    `/organizer/sessions/${sessionId}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  )
}

export function publishOrganizerSession(
  accessToken: string,
  sessionId: string,
): Promise<OrganizerSession> {
  return authenticatedRequest<OrganizerSession>(
    `/organizer/sessions/${sessionId}/publish`,
    accessToken,
    { method: 'POST' },
  )
}

/**
 * Cria um novo rascunho copiando somente a estrutura da sessão de origem.
 * Nenhum dado transacional é copiado pelo backend.
 */
export function duplicateOrganizerSession(
  accessToken: string,
  sessionId: string,
): Promise<OrganizerSession> {
  return authenticatedRequest<OrganizerSession>(
    `/organizer/sessions/${encodeURIComponent(sessionId)}/duplicate`,
    accessToken,
    { method: 'POST' },
  )
}

export async function getPublicSessions(
  query = '',
  signal?: AbortSignal,
): Promise<PublicSessionSummary[]> {
  const params = new URLSearchParams()
  const normalizedQuery = query.trim()

  if (normalizedQuery) {
    params.set('q', normalizedQuery)
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await publicRequest<PublicSessionsResponse>(
    `/sessions${suffix}`,
    signal,
  )

  return response.sessions
}

export function getPublicSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PublicSessionDetail> {
  return publicRequest<PublicSessionDetail>(`/sessions/${sessionId}`, signal)
}

export async function getSessionSeats(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSeat[]> {
  const response = await publicRequest<SeatsResponse>(
    `/sessions/${sessionId}/seats`,
    signal,
  )

  return response.seats
}

export function createReservation(
  accessToken: string,
  sessionId: string,
  seatIds: string[],
): Promise<Reservation> {
  return authenticatedRequest<Reservation>('/reservations', accessToken, {
    method: 'POST',
    body: JSON.stringify({ sessionId, seatIds }),
  })
}

export function getReservation(
  accessToken: string,
  reservationId: string,
  signal?: AbortSignal,
): Promise<Reservation> {
  return authenticatedRequest<Reservation>(
    `/reservations/${reservationId}`,
    accessToken,
    { signal: signal ?? null },
  )
}

export function payReservation(
  accessToken: string,
  reservationId: string,
  outcome: PaymentStatus,
): Promise<PaymentResult> {
  return authenticatedRequest<PaymentResult>(
    `/reservations/${reservationId}/payment`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    },
  )
}

export function cancelReservation(
  accessToken: string,
  reservationId: string,
): Promise<ReservationCancellationResult> {
  return authenticatedRequest<ReservationCancellationResult>(
    `/reservations/${encodeURIComponent(reservationId)}/cancel`,
    accessToken,
    { method: 'POST' },
  )
}

export async function getMyTickets(
  accessToken: string,
  signal?: AbortSignal,
): Promise<TicketSummary[]> {
  const response = await authenticatedRequest<TicketsResponse>(
    '/me/tickets',
    accessToken,
    { signal: signal ?? null },
  )

  return response.tickets
}

export function getMyTicket(
  accessToken: string,
  ticketId: string,
  signal?: AbortSignal,
): Promise<TicketDetail> {
  return authenticatedRequest<TicketDetail>(
    `/me/tickets/${ticketId}`,
    accessToken,
    { signal: signal ?? null },
  )
}

export function cancelTicket(
  accessToken: string,
  ticketId: string,
): Promise<TicketCancellationResult> {
  return authenticatedRequest<TicketCancellationResult>(
    `/me/tickets/${encodeURIComponent(ticketId)}/cancel`,
    accessToken,
    { method: 'POST' },
  )
}

export function createTicketShareLink(
  accessToken: string,
  ticketId: string,
): Promise<ShareLinkResult> {
  return authenticatedRequest<ShareLinkResult>(
    `/me/tickets/${ticketId}/share-link`,
    accessToken,
    { method: 'POST' },
  )
}

export async function revokeTicketShareLink(
  accessToken: string,
  ticketId: string,
): Promise<void> {
  await authenticatedRequest<unknown>(
    `/me/tickets/${ticketId}/share-link`,
    accessToken,
    { method: 'DELETE' },
  )
}

export function getSharedTicket(
  token: string,
  signal?: AbortSignal,
): Promise<SharedTicket> {
  return publicRequest<SharedTicket>(
    `/shared/${encodeURIComponent(token)}`,
    signal,
  )
}

export async function getGateSessions(
  accessToken: string,
  signal?: AbortSignal,
): Promise<GateSession[]> {
  const response = await authenticatedRequest<GateSessionsResponse>(
    '/gate/sessions',
    accessToken,
    { signal: signal ?? null },
  )

  return response.sessions
}

export function consumeGateTicket(
  accessToken: string,
  sessionId: string,
  credential: string,
): Promise<GateConsumeResult> {
  return authenticatedRequest<GateConsumeResult>(
    '/gate/tickets/consume',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ sessionId, credential }),
    },
  )
}
