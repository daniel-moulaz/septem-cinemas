import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  createReservation,
  getPublicSession,
  getSessionSeats,
  sessionEventsUrl,
  type AuthenticatedUser,
  type PublicSessionDetail,
  type Reservation,
  type SessionSeat,
} from '../../api'
import { createCalendarFile, downloadCalendarFile } from '../../calendar'
import {
  formatSessionDay,
  formatPrice,
  formatSessionTime,
  movieYear,
  tmdbBackdropUrl,
  tmdbPosterUrl,
} from '../organizer/formatters'
import { PosterImage } from '../common/PosterImage'
import { ServerStartingNotice } from '../common/ServerStartingNotice'
import { useToast } from '../common/toast'

const maximumSeatsPerReservation = 6
/**
 * O polling permanece como rede de segurança: se um evento SSE se perder ou a
 * conexão cair, o mapa ainda converge para o estado autoritativo do servidor.
 */
const seatAvailabilityPollingMilliseconds = 8_000
/** Teto defensivo para o refresh encadeado, evitando um laço infinito. */
const maximumTrailingRefreshes = 8

function joinSeatLabels(labels: string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? ''
  }

  return `${labels.slice(0, -1).join(', ')} e ${labels.at(-1)}`
}

function unavailableSeatsMessage(labels: string[]): string {
  const joinedLabels = joinSeatLabels(labels)

  return labels.length === 1
    ? `${joinedLabels} acabou de ficar indisponível.`
    : `${joinedLabels} acabaram de ficar indisponíveis.`
}

interface SessionDetailProps {
  sessionId: string
  user: AuthenticatedUser | undefined
  accessToken: string | undefined
  onBack: () => void
  onRequireLogin: () => void
  onReservationCreated: (reservation: Reservation) => void
}

function groupSeatsByRow(seats: SessionSeat[]): Array<[string, SessionSeat[]]> {
  const rows = new Map<string, SessionSeat[]>()

  for (const seat of seats) {
    const row = rows.get(seat.rowLabel)

    if (row) {
      row.push(seat)
    } else {
      rows.set(seat.rowLabel, [seat])
    }
  }

  return Array.from(rows.entries())
}

export function SessionDetail({
  sessionId,
  user,
  accessToken,
  onBack,
  onRequireLogin,
  onReservationCreated,
}: SessionDetailProps) {
  const { notify } = useToast()
  const [session, setSession] = useState<PublicSessionDetail | null>(null)
  const [seats, setSeats] = useState<SessionSeat[]>([])
  const [selectedSeatIds, setSelectedSeatIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [message, setMessage] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [failedBackdrop, setFailedBackdrop] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<
    'idle' | 'live' | 'reconnecting'
  >('idle')
  const seatsRef = useRef<SessionSeat[]>([])
  const selectedSeatIdsRef = useRef<Set<string>>(new Set())
  const refreshControllerRef = useRef<AbortController | null>(null)
  const refreshInFlightRef = useRef(false)
  const refreshPendingRef = useRef(false)
  const reservationSubmissionRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      refreshControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    Promise.all([
      getPublicSession(sessionId, controller.signal),
      getSessionSeats(sessionId, controller.signal),
    ])
      .then(([sessionResult, seatResult]) => {
        if (controller.signal.aborted) return
        setSession(sessionResult)
        setSeats(seatResult)
        seatsRef.current = seatResult
        setMessage(null)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setMessage(
          error instanceof ApiError
            ? error.message
            : 'Não foi possível carregar esta sessão.',
        )
        setStatus('error')
        controller.abort()
      })

    return () => controller.abort()
  }, [reloadKey, sessionId])

  useEffect(() => {
    seatsRef.current = seats
  }, [seats])

  useEffect(() => {
    selectedSeatIdsRef.current = selectedSeatIds
  }, [selectedSeatIds])

  const rows = useMemo(() => groupSeatsByRow(seats), [seats])
  const selectedSeats = useMemo(
    () => seats.filter((seat) => selectedSeatIds.has(seat.id)),
    [seats, selectedSeatIds],
  )
  const availableCount = useMemo(
    () => seats.filter((seat) => seat.status === 'AVAILABLE').length,
    [seats],
  )
  const estimatedTotal = (session?.priceCents ?? 0) * selectedSeats.length

  function toggleSeat(seat: SessionSeat) {
    if (seat.status !== 'AVAILABLE') {
      return
    }

    setMessage(null)

    if (
      !selectedSeatIds.has(seat.id) &&
      selectedSeatIds.size >= maximumSeatsPerReservation
    ) {
      setMessage(
        `Selecione no máximo ${maximumSeatsPerReservation} lugares por reserva.`,
      )
      return
    }

    setSelectedSeatIds((current) => {
      const next = new Set(current)

      if (next.has(seat.id)) {
        next.delete(seat.id)
        selectedSeatIdsRef.current = next
        return next
      }

      next.add(seat.id)
      selectedSeatIdsRef.current = next
      return next
    })
  }

  function retrySession() {
    setStatus('loading')
    setMessage(null)
    const emptySelection = new Set<string>()
    selectedSeatIdsRef.current = emptySelection
    setSelectedSeatIds(emptySelection)
    setReloadKey((value) => value + 1)
  }

  const refreshAvailability = useCallback(
    async ({
      source = 'manual',
      clearCurrentMessage = true,
      notifyLostSeats = true,
    }: {
      source?: 'manual' | 'background'
      clearCurrentMessage?: boolean
      notifyLostSeats?: boolean
    } = {}) => {
      // Single-flight: uma segunda chamada durante um fetch em andamento não é
      // descartada; ela marca o snapshot como sujo e o loop abaixo executa mais
      // uma rodada ao terminar. Assim nenhuma invalidação se perde e uma
      // resposta antiga nunca sobrescreve outra mais nova.
      if (refreshInFlightRef.current) {
        refreshPendingRef.current = true
        return
      }

      refreshInFlightRef.current = true

      if (source === 'manual') {
        setIsRefreshing(true)
        if (clearCurrentMessage) {
          setMessage(null)
        }
      }

      try {
        let remainingTrailingRefreshes = maximumTrailingRefreshes

        do {
          refreshPendingRef.current = false

          const controller = new AbortController()
          refreshControllerRef.current = controller

          try {
            const refreshedSeats = await getSessionSeats(
              sessionId,
              controller.signal,
            )
            const currentSelection = selectedSeatIdsRef.current
            const previousSeats = seatsRef.current
            const availableIds = new Set(
              refreshedSeats
                .filter((seat) => seat.status === 'AVAILABLE')
                .map((seat) => seat.id),
            )
            const unavailableSelectedIds = Array.from(currentSelection).filter(
              (seatId) => !availableIds.has(seatId),
            )

            if (!mountedRef.current || controller.signal.aborted) {
              return
            }

            seatsRef.current = refreshedSeats
            setSeats(refreshedSeats)

            if (unavailableSelectedIds.length > 0) {
              const labelsById = new Map(
                [...previousSeats, ...refreshedSeats].map((seat) => [
                  seat.id,
                  seat.label,
                ]),
              )
              const next = new Set<string>()

              for (const seatId of currentSelection) {
                if (availableIds.has(seatId)) {
                  next.add(seatId)
                }
              }

              selectedSeatIdsRef.current = next
              setSelectedSeatIds(next)

              if (notifyLostSeats) {
                const lostLabels = unavailableSelectedIds.map(
                  (seatId) => labelsById.get(seatId) ?? 'Um lugar selecionado',
                )
                notify(unavailableSeatsMessage(lostLabels), 'info')
              }
            }
          } catch (error) {
            if (controller.signal.aborted || !mountedRef.current) {
              return
            }

            if (source === 'manual') {
              setMessage(
                error instanceof ApiError
                  ? error.message
                  : 'Não foi possível atualizar os lugares.',
              )
            }

            // Uma falha encerra a rodada; o polling continua como rede de
            // segurança e evita um laço apertado de novas tentativas.
            return
          } finally {
            if (refreshControllerRef.current === controller) {
              refreshControllerRef.current = null
            }
          }

          remainingTrailingRefreshes -= 1
        } while (
          refreshPendingRef.current &&
          remainingTrailingRefreshes > 0 &&
          mountedRef.current
        )
      } finally {
        refreshInFlightRef.current = false
        refreshPendingRef.current = false

        if (source === 'manual' && mountedRef.current) {
          setIsRefreshing(false)
        }
      }
    },
    [notify, sessionId],
  )

  useEffect(() => {
    if (status !== 'ready' || typeof EventSource === 'undefined') {
      return
    }

    const source = new EventSource(sessionEventsUrl(sessionId))
    let detailController: AbortController | undefined

    function handleInvalidation() {
      // O evento nunca traz o estado dos assentos: ele apenas manda reconsultar
      // o snapshot autoritativo do servidor.
      void refreshAvailability({ source: 'background' })
    }

    function handleOpen() {
      setRealtimeStatus('live')
    }

    function handleSync() {
      setRealtimeStatus('live')
      handleInvalidation()
    }

    function handleSessionChanged() {
      // Dados estruturais mudaram (horário, local, preço, filme ou layout):
      // reconsulta a sessão e o mapa, que continuam sendo a autoridade.
      detailController?.abort()
      const controller = new AbortController()
      detailController = controller
      getPublicSession(sessionId, controller.signal)
        .then((refreshed) => {
          if (mountedRef.current && !controller.signal.aborted) {
            setSession(refreshed)
          }
        })
        .catch(() => undefined)

      handleInvalidation()
    }

    function handleError() {
      // O EventSource reconecta sozinho; o polling cobre a janela offline.
      setRealtimeStatus('reconnecting')
    }

    source.addEventListener('open', handleOpen)
    source.addEventListener('sync', handleSync)
    source.addEventListener('seats-changed', handleInvalidation)
    source.addEventListener('session-changed', handleSessionChanged)
    source.addEventListener('error', handleError)

    return () => {
      detailController?.abort()
      source.removeEventListener('open', handleOpen)
      source.removeEventListener('sync', handleSync)
      source.removeEventListener('seats-changed', handleInvalidation)
      source.removeEventListener('session-changed', handleSessionChanged)
      source.removeEventListener('error', handleError)
      source.close()
      setRealtimeStatus('idle')
    }
  }, [refreshAvailability, sessionId, status])

  useEffect(() => {
    if (status !== 'ready' || isSubmitting) {
      return
    }

    let timerId: number | undefined
    let stopped = false

    function clearTimer() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId)
        timerId = undefined
      }
    }

    function scheduleNextRefresh() {
      clearTimer()

      if (!stopped && !document.hidden) {
        timerId = window.setTimeout(() => {
          void pollAvailability()
        }, seatAvailabilityPollingMilliseconds)
      }
    }

    async function pollAvailability() {
      if (stopped || document.hidden) {
        return
      }

      await refreshAvailability({ source: 'background' })
      scheduleNextRefresh()
    }

    function handleVisibilityChange() {
      clearTimer()

      if (document.hidden) {
        refreshControllerRef.current?.abort()
        return
      }

      void pollAvailability()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    scheduleNextRefresh()

    return () => {
      stopped = true
      clearTimer()
      refreshControllerRef.current?.abort()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [isSubmitting, refreshAvailability, status])

  async function handleReservation() {
    if (reservationSubmissionRef.current) {
      return
    }

    if (!user || !accessToken) {
      onRequireLogin()
      return
    }

    if (user.role !== 'CUSTOMER') {
      setMessage('Apenas clientes podem reservar lugares.')
      return
    }

    if (selectedSeatIds.size === 0) {
      setMessage('Selecione ao menos um lugar.')
      return
    }

    reservationSubmissionRef.current = true
    refreshControllerRef.current?.abort()
    refreshControllerRef.current = null
    refreshInFlightRef.current = false
    refreshPendingRef.current = false
    setIsSubmitting(true)
    setMessage(null)

    try {
      const reservation = await createReservation(
        accessToken,
        sessionId,
        Array.from(selectedSeatIds),
      )
      onReservationCreated(reservation)
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'SEAT_UNAVAILABLE' ||
          (error.status === 409 && error.code === undefined))
      ) {
        setMessage(
          'Um ou mais lugares acabaram de ficar indisponíveis. Atualizamos o mapa para você escolher novamente.',
        )
        await refreshAvailability({
          clearCurrentMessage: false,
          notifyLostSeats: false,
        })
      } else {
        setMessage(
          error instanceof ApiError
            ? error.message
            : 'Não foi possível reservar os lugares.',
        )
      }
    } finally {
      reservationSubmissionRef.current = false
      if (mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  async function shareSession() {
    if (!session) {
      return
    }

    const sessionUrl = new URL(
      `/sessions/${encodeURIComponent(session.id)}`,
      window.location.origin,
    ).toString()

    async function copySessionLink() {
      if (!navigator.clipboard) {
        notify('Copie o endereço desta página no navegador.', 'info')
        return
      }

      try {
        await navigator.clipboard.writeText(sessionUrl)
        notify('Link da sessão copiado.', 'success')
      } catch {
        notify('Não foi possível copiar o link da sessão.', 'error')
      }
    }

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `SEPTEM — ${session.movie.title}`,
          text: `${formatSessionDay(session.startsAt)}, às ${formatSessionTime(session.startsAt)} · ${session.venueName}, ${session.roomName}`,
          url: sessionUrl,
        })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        await copySessionLink()
        return
      }
    }

    await copySessionLink()
  }

  function addSessionToCalendar() {
    if (!session) {
      return
    }

    try {
      downloadCalendarFile(
        createCalendarFile({
          id: session.id,
          movieTitle: session.movie.title,
          startsAt: session.startsAt,
          runtimeMinutes: session.movie.runtimeMinutes,
          venueName: session.venueName,
          roomName: session.roomName,
          address: session.address,
        }),
      )
      notify('Arquivo da agenda preparado.', 'success')
    } catch {
      notify('Não foi possível preparar o arquivo da agenda.', 'error')
    }
  }

  if (status === 'loading') {
    return (
      <div className="public-content">
        <ServerStartingNotice />
        <div className="content-state public-state" aria-live="polite" aria-busy="true">
          <p className="section-kicker">Carregando</p>
          <h1>Preparando a sala…</h1>
        </div>
      </div>
    )
  }

  if (status === 'error' || !session) {
    return (
      <div className="public-content">
        <div className="content-state public-state" role="alert">
          <p className="section-kicker">Sessão indisponível</p>
          <h1>Não conseguimos abrir esta sessão.</h1>
          <p>{message}</p>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onBack}>
              Voltar
            </button>
            <button type="button" onClick={retrySession}>
              Tentar novamente
            </button>
          </div>
        </div>
      </div>
    )
  }

  const posterUrl = tmdbPosterUrl(session.movie.posterPath)
  const backdropUrl = tmdbBackdropUrl(session.movie.backdropPath)

  return (
    <div className="public-content session-detail-page">
      <button type="button" className="back-button" onClick={onBack}>
        <span aria-hidden="true">←</span> Voltar à programação
      </button>

      <article className="public-session-hero">
        {backdropUrl && failedBackdrop !== backdropUrl ? (
          <img
            className="session-backdrop"
            src={backdropUrl}
            alt=""
            aria-hidden="true"
            onError={() => setFailedBackdrop(backdropUrl)}
          />
        ) : null}
        <div className="session-hero-content">
          <PosterImage
            className="detail-poster"
            src={posterUrl}
            title={session.movie.title}
            loading="eager"
            variant="hero"
          />
          <div className="session-title-block">
            <p className="section-kicker">Em cartaz</p>
            <h1>{session.movie.title}</h1>
            <p className="detail-movie-meta">
              {session.movie.releaseDate ? (
                <span>{movieYear(session.movie.releaseDate)}</span>
              ) : null}
              {session.movie.runtimeMinutes ? (
                <span>{session.movie.runtimeMinutes} min</span>
              ) : null}
            </p>
          </div>
          <dl className="detail-facts">
            <div className="detail-showtime">
              <dt>Sessão</dt>
              <dd>
                <time dateTime={session.startsAt}>
                  <strong>{formatSessionTime(session.startsAt)}</strong>
                  <span>{formatSessionDay(session.startsAt)}</span>
                </time>
              </dd>
            </div>
            <div className="detail-cinema">
              <dt>Cinema</dt>
              <dd>
                <strong>{session.venueName}</strong>
                <span>{session.roomName}</span>
              </dd>
            </div>
            <div className="detail-address">
              <dt>Endereço</dt>
              <dd>{session.address}</dd>
            </div>
            <div className="detail-price">
              <dt>Ingresso</dt>
              <dd>{formatPrice(session.priceCents)}</dd>
            </div>
          </dl>
          <p className="movie-overview">
            {session.movie.overview || 'Sinopse não informada.'}
          </p>
        </div>
      </article>

      <div
        className="session-utility-actions"
        role="group"
        aria-label="Ações desta sessão"
      >
        <button
          type="button"
          className="secondary-button"
          onClick={() => void shareSession()}
        >
          Compartilhar sessão
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={addSessionToCalendar}
        >
          Adicionar à agenda
        </button>
      </div>

      <section className="seat-selection" aria-labelledby="seat-map-heading">
        <div className="seat-map-heading">
          <div>
            <p className="section-kicker">Escolha seus lugares</p>
            <h2 id="seat-map-heading">Mapa da sala</h2>
            <p>
              {availableCount} de {session.capacity} lugares disponíveis. Limite
              de {maximumSeatsPerReservation} por reserva.
            </p>
            {realtimeStatus === 'idle' ? null : (
              <p
                className="realtime-indicator"
                data-state={realtimeStatus}
                aria-live="polite"
              >
                {realtimeStatus === 'live'
                  ? 'Atualizações em tempo real'
                  : 'Reconectando atualizações'}
              </p>
            )}
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void refreshAvailability()}
            disabled={isRefreshing || isSubmitting}
          >
            {isRefreshing ? 'Atualizando…' : 'Atualizar lugares'}
          </button>
        </div>

        {message ? (
          <p className="message error-message selection-feedback" role="alert">
            {message}
          </p>
        ) : null}

        <div className="seat-workspace">
          <div className="seat-map-panel">
            <div className="screen-indicator" aria-label="Tela do cinema">
              <span>TELA</span>
            </div>
            <p className="seat-scroll-hint" aria-hidden="true">
              Deslize para os lados para ver toda a fileira.
            </p>

            <div
              className="seat-map-scroll"
              role="region"
              aria-label="Mapa de assentos; role horizontalmente em salas maiores"
              tabIndex={0}
            >
              <div
                className="seat-map"
                role="group"
                aria-labelledby="seat-map-heading"
              >
                {rows.map(([rowLabel, rowSeats]) => (
                  <div className="seat-row" key={rowLabel}>
                    <span className="row-label" aria-hidden="true">
                      {rowLabel}
                    </span>
                    <div className="seat-buttons">
                      {rowSeats.map((seat) => {
                        const isSelected = selectedSeatIds.has(seat.id)
                        const isAvailable = seat.status === 'AVAILABLE'
                        const stateLabel = isSelected
                          ? 'selecionado'
                          : isAvailable
                            ? 'disponível'
                            : seat.status === 'SOLD'
                              ? 'vendido'
                              : 'indisponível'

                        return (
                          <button
                            type="button"
                            className={`seat-button ${isSelected ? 'seat-selected' : ''} ${isAvailable ? 'seat-available' : 'seat-unavailable'}`}
                            key={seat.id}
                            onClick={() => toggleSeat(seat)}
                            disabled={!isAvailable}
                            aria-label={`Assento ${seat.label}, ${stateLabel}`}
                            title={`Assento ${seat.label}, ${stateLabel}`}
                            aria-pressed={isAvailable ? isSelected : undefined}
                          >
                            <span className="seat-shape" aria-hidden="true">
                              {isSelected ? '✓' : isAvailable ? '' : '×'}
                            </span>
                            <span>{seat.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <span className="row-label row-label-end" aria-hidden="true">
                      {rowLabel}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <ul className="seat-legend" aria-label="Legenda do mapa">
              <li><span className="legend-seat available-symbol" aria-hidden="true" /> Disponível</li>
              <li><span className="legend-seat selected-symbol" aria-hidden="true">✓</span> Selecionado</li>
              <li><span className="legend-seat unavailable-symbol" aria-hidden="true">×</span> Indisponível</li>
            </ul>
          </div>

          <aside
            className="selection-summary"
            aria-label="Resumo da seleção"
          >
            <p className="section-kicker">Sua seleção</p>
            <div>
              <span>Assentos</span>
              <strong aria-live="polite" aria-atomic="true">
                {selectedSeats.length > 0
                  ? selectedSeats.map((seat) => seat.label).join(', ')
                  : 'Nenhum selecionado'}
              </strong>
            </div>
            <div className="selection-total">
              <span>Total</span>
              <strong>{formatPrice(estimatedTotal)}</strong>
            </div>

            <button
              type="button"
              onClick={() => void handleReservation()}
              disabled={
                selectedSeatIds.size === 0 || isSubmitting || isRefreshing
              }
            >
              {isSubmitting ? 'Reservando…' : 'Reservar por 10 minutos'}
            </button>
            <p className="backend-authority-note">
              Disponibilidade e valor final confirmados pelo servidor.
            </p>
          </aside>
        </div>

        <aside
          className={`mobile-booking-bar ${selectedSeats.length > 0 ? 'has-selection' : 'is-empty'}`}
          aria-label="Resumo da seleção e reserva"
        >
          <div className="mobile-booking-summary">
            <strong>
              {selectedSeats.length > 0
                ? selectedSeats.map((seat) => seat.label).join(', ')
                : 'Selecione seus lugares'}
            </strong>
            <span>
              {selectedSeats.length}{' '}
              {selectedSeats.length === 1 ? 'lugar' : 'lugares'} ·{' '}
              {formatPrice(estimatedTotal)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleReservation()}
            disabled={
              selectedSeatIds.size === 0 || isSubmitting || isRefreshing
            }
          >
            {isSubmitting ? 'Reservando…' : 'Reservar por 10 minutos'}
          </button>
        </aside>
      </section>
    </div>
  )
}
