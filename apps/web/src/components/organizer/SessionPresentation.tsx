import type { OrganizerSession, SessionEditabilityReason } from '../../api'
import { formatPrice, formatSessionDate, tmdbPosterUrl } from './formatters'
import { PosterImage } from '../common/PosterImage'

interface RoomLayoutPreviewProps {
  rows: number
  seatsPerRow: number
}

export function RoomLayoutPreview({ rows, seatsPerRow }: RoomLayoutPreviewProps) {
  const isValid =
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 10 &&
    Number.isInteger(seatsPerRow) &&
    seatsPerRow >= 1 &&
    seatsPerRow <= 20

  if (!isValid) {
    return (
      <div className="room-layout-preview room-layout-invalid">
        Informe um layout válido para visualizar a sala.
      </div>
    )
  }

  return (
    <div
      className="room-layout-preview"
      role="img"
      aria-label={`Prévia da sala com ${rows} fileiras e ${seatsPerRow} assentos por fileira`}
    >
      <div className="room-preview-screen" aria-hidden="true">Tela</div>
      <div className="room-preview-scroll" aria-hidden="true">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div className="room-preview-row" key={rowIndex}>
            <span>{String.fromCharCode(65 + rowIndex)}</span>
            <div
              className="room-preview-seats"
              style={{ gridTemplateColumns: `repeat(${seatsPerRow}, 0.65rem)` }}
            >
              {Array.from({ length: seatsPerRow }, (_, seatIndex) => (
                <i key={seatIndex} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * O motivo do bloqueio vem sempre do backend; a UI apenas o traduz. Nunca
 * voltar ao antigo "Estrutura bloqueada após publicação": publicar deixou de
 * ser, por si só, um motivo de bloqueio.
 */
function lockedSessionTitle(reason: SessionEditabilityReason): string {
  if (reason === 'SESSION_STARTED') {
    return 'A sessão já começou.'
  }

  if (reason === 'ACTIVE_HOLD') {
    return 'Há uma reserva ativa agora.'
  }

  return 'Esta sessão possui reservas ou ingressos associados.'
}

function lockedSessionExplanation(reason: SessionEditabilityReason): string {
  if (reason === 'SESSION_STARTED') {
    return ' Depois do horário de início, filme, local, preço e assentos não podem mais ser alterados.'
  }

  if (reason === 'ACTIVE_HOLD') {
    return ' Aguarde o prazo da reserva terminar ou a compra ser concluída para alterar esta sessão.'
  }

  return ' Filme, horário, local, preço e layout não podem mais ser alterados.'
}

interface SessionOperationsPanelProps {
  session: OrganizerSession
}

/**
 * Painel operacional compacto. Todos os números vêm calculados do backend;
 * a UI não deriva nem estima nada.
 */
export function SessionOperationsPanel({ session }: SessionOperationsPanelProps) {
  const { metrics } = session

  return (
    <section className="session-metrics" aria-labelledby="session-metrics-title">
      <p className="section-kicker">Operação da sessão</p>
      <h2 id="session-metrics-title" className="visually-hidden">
        Métricas operacionais
      </h2>
      <dl className="published-facts">
        <div>
          <dt>Capacidade</dt>
          <dd>
            <strong>{metrics.capacity}</strong>
            lugares
          </dd>
        </div>
        <div>
          <dt>Disponíveis</dt>
          <dd>
            <strong>{metrics.availableSeats}</strong>
            livres agora
          </dd>
        </div>
        <div>
          <dt>Reservas ativas</dt>
          <dd>
            <strong>{metrics.heldSeats}</strong>
            em hold
          </dd>
        </div>
        <div>
          <dt>Vendidos</dt>
          <dd>
            <strong>{metrics.soldSeats}</strong>
            ingressos vigentes
          </dd>
        </div>
        <div>
          <dt>Ocupação</dt>
          <dd>
            <strong>
              {metrics.occupancyPercentage.toLocaleString('pt-BR', {
                maximumFractionDigits: 1,
              })}
              %
            </strong>
            do total de lugares
          </dd>
        </div>
        <div>
          <dt>Receita simulada</dt>
          <dd>
            <strong>{formatPrice(metrics.simulatedRevenueCents)}</strong>
            assentos vendidos agora
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <strong>
              {session.status === 'PUBLISHED' ? 'Publicada' : 'Rascunho'}
            </strong>
            {session.editability.allowed ? 'editável' : 'bloqueada para edição'}
          </dd>
        </div>
        <div>
          <dt>Data e hora</dt>
          <dd>
            <strong>{formatSessionDate(session.startsAt)}</strong>
            {session.venueName} · {session.roomName}
          </dd>
        </div>
      </dl>
    </section>
  )
}

interface PublishedSessionProps {
  session: OrganizerSession
}

export function PublishedSession({ session }: PublishedSessionProps) {
  const posterUrl = tmdbPosterUrl(session.movie.posterPath)
  const movieMeta = [
    session.movie.releaseDate?.slice(0, 4),
    session.movie.runtimeMinutes
      ? `${session.movie.runtimeMinutes} min`
      : null,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <article className="published-session">
      <div className="published-movie">
        <PosterImage
          src={posterUrl}
          title={session.movie.title}
          className="published-movie-poster"
        />
        <div>
          <span className="status-badge status-published">Publicada</span>
          <h2>{session.movie.title}</h2>
          {movieMeta.length > 0 ? (
            <p className="movie-meta">{movieMeta.join(' · ')}</p>
          ) : null}
          {session.movie.overview ? <p>{session.movie.overview}</p> : null}
        </div>
      </div>

      <dl className="published-facts">
        <div>
          <dt>Data e hora</dt>
          <dd>{formatSessionDate(session.startsAt)}</dd>
        </div>
        <div>
          <dt>Local</dt>
          <dd>{session.venueName}</dd>
        </div>
        <div>
          <dt>Sala</dt>
          <dd>{session.roomName}</dd>
        </div>
        <div>
          <dt>Endereço</dt>
          <dd>{session.address}</dd>
        </div>
        <div>
          <dt>Ingresso</dt>
          <dd>{formatPrice(session.priceCents)}</dd>
        </div>
        <div>
          <dt>Layout</dt>
          <dd>
            {session.rows} fileiras · {session.seatsPerRow} por fileira ·{' '}
            {session.capacity} lugares
          </dd>
        </div>
      </dl>

      <p className="locked-notice">
        <span aria-hidden="true">●</span>
        <span>
          <strong>{lockedSessionTitle(session.editability.reason)}</strong>
          {lockedSessionExplanation(session.editability.reason)}
        </span>
      </p>
    </article>
  )
}
