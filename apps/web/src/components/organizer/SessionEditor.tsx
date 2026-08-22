import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  ApiError,
  createOrganizerSession,
  duplicateOrganizerSession,
  getOrganizerSession,
  publishOrganizerSession,
  sessionEventsUrl,
  updateOrganizerSession,
  type CatalogMovie,
  type OrganizerSession,
  type SessionEditabilityReason,
  type SessionInput,
  type SessionUpdateInput,
} from '../../api'
import {
  formatPrice,
  formatSessionDate,
  tmdbPosterUrl,
  toDateTimeLocalValue,
} from './formatters'
import { PosterImage } from '../common/PosterImage'
import { useToast } from '../common/toast'
import { MoviePicker } from './MoviePicker'

interface SessionEditorProps {
  accessToken: string
  sessionId?: string
  onBack: () => void
  onCreated?: (sessionId: string) => void
  onDirtyChange: (isDirty: boolean) => void
  onBusyChange: (isBusy: boolean) => void
}

interface SessionFormState {
  startsAt: string
  venueName: string
  roomName: string
  address: string
  price: string
  rows: string
  seatsPerRow: string
}

type SessionFormField = keyof SessionFormState | 'movie'
type SessionFormErrors = Partial<Record<SessionFormField, string>>

interface SessionValidation {
  input: SessionInput | null
  errors: SessionFormErrors
}

/**
 * Operação em curso no editor. Salvar, publicar e escolher filme não podem
 * acontecer ao mesmo tempo — cada uma desabilita os controles das outras —,
 * então convivem em um único estado em vez de três booleanos independentes.
 * Duplicar não entra aqui: ela sai do editor em vez de operar sobre ele.
 */
type EditorAction = 'idle' | 'saving' | 'publishing' | 'selecting-movie'

const emptyForm: SessionFormState = {
  startsAt: '',
  venueName: '',
  roomName: '',
  address: '',
  price: '',
  rows: '6',
  seatsPerRow: '10',
}

function formFromSession(session: OrganizerSession): SessionFormState {
  return {
    startsAt: toDateTimeLocalValue(session.startsAt),
    venueName: session.venueName,
    roomName: session.roomName,
    address: session.address,
    price: (session.priceCents / 100).toFixed(2),
    rows: String(session.rows),
    seatsPerRow: String(session.seatsPerRow),
  }
}

function movieFromSession(session: OrganizerSession): CatalogMovie {
  return {
    id: session.movie.tmdbId,
    title: session.movie.title,
    overview: session.movie.overview,
    posterPath: session.movie.posterPath,
    backdropPath: session.movie.backdropPath,
    releaseDate: session.movie.releaseDate,
    runtimeMinutes: session.movie.runtimeMinutes,
  }
}

function changesFromSession(
  session: OrganizerSession,
  input: SessionInput,
): SessionUpdateInput {
  const changes: SessionUpdateInput = {}

  if (input.tmdbMovieId !== session.movie.tmdbId) {
    changes.tmdbMovieId = input.tmdbMovieId
  }

  if (new Date(input.startsAt).getTime() !== new Date(session.startsAt).getTime()) {
    changes.startsAt = input.startsAt
  }

  if (input.venueName !== session.venueName) {
    changes.venueName = input.venueName
  }

  if (input.roomName !== session.roomName) {
    changes.roomName = input.roomName
  }

  if (input.address !== session.address) {
    changes.address = input.address
  }

  if (input.priceCents !== session.priceCents) {
    changes.priceCents = input.priceCents
  }

  if (
    input.rows !== session.rows ||
    input.seatsPerRow !== session.seatsPerRow
  ) {
    changes.rows = input.rows
    changes.seatsPerRow = input.seatsPerRow
  }

  return changes
}

function validateForm(
  form: SessionFormState,
  movie: CatalogMovie | null,
): SessionValidation {
  const errors: SessionFormErrors = {}

  if (!movie) {
    errors.movie = 'Selecione um filme antes de salvar.'
  }

  const startsAt = new Date(form.startsAt)
  if (!form.startsAt || Number.isNaN(startsAt.getTime())) {
    errors.startsAt = 'Informe uma data e hora válidas.'
  } else if (startsAt.getTime() <= Date.now()) {
    errors.startsAt = 'A sessão precisa começar no futuro.'
  }

  const price = Number(form.price)
  const rows = Number(form.rows)
  const seatsPerRow = Number(form.seatsPerRow)

  if (!form.price.trim() || !Number.isFinite(price) || price < 0) {
    errors.price = 'Informe um preço válido, igual ou maior que zero.'
  } else if (price > 100_000) {
    errors.price = 'O preço máximo é R$ 100.000,00.'
  } else if (!/^\d+(?:\.\d{1,2})?$/.test(form.price)) {
    errors.price = 'Use no máximo duas casas decimais.'
  }

  if (!Number.isInteger(rows) || rows < 1 || rows > 10) {
    errors.rows = 'Informe entre 1 e 10 fileiras.'
  }

  if (
    !Number.isInteger(seatsPerRow) ||
    seatsPerRow < 1 ||
    seatsPerRow > 20
  ) {
    errors.seatsPerRow = 'Informe entre 1 e 20 assentos por fileira.'
  }

  if (!form.venueName.trim()) {
    errors.venueName = 'Informe o cinema ou local.'
  }

  if (!form.roomName.trim()) {
    errors.roomName = 'Informe a sala.'
  }

  if (!form.address.trim()) {
    errors.address = 'Informe o endereço.'
  }

  if (!movie || Object.keys(errors).length > 0) {
    return { input: null, errors }
  }

  return {
    input: {
      tmdbMovieId: movie.id,
      startsAt: startsAt.toISOString(),
      venueName: form.venueName.trim(),
      roomName: form.roomName.trim(),
      address: form.address.trim(),
      priceCents: Math.round(price * 100),
      rows,
      seatsPerRow,
    },
    errors,
  }
}

interface RoomLayoutPreviewProps {
  rows: number
  seatsPerRow: number
}

function RoomLayoutPreview({ rows, seatsPerRow }: RoomLayoutPreviewProps) {
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
function SessionOperationsPanel({ session }: SessionOperationsPanelProps) {
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

function PublishedSession({ session }: PublishedSessionProps) {
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

export function SessionEditor({
  accessToken,
  sessionId,
  onBack,
  onCreated,
  onDirtyChange,
  onBusyChange,
}: SessionEditorProps) {
  const { notify } = useToast()
  const [session, setSession] = useState<OrganizerSession | null>(null)
  const [selectedMovie, setSelectedMovie] = useState<CatalogMovie | null>(null)
  const [form, setForm] = useState<SessionFormState>(emptyForm)
  const [isLoading, setIsLoading] = useState(Boolean(sessionId))
  // Salvar, publicar e escolher filme são mutuamente exclusivos por
  // construção: cada um desabilita os controles dos outros enquanto corre.
  // Um único estado discriminado torna isso explícito e impede a combinação
  // impossível de dois deles ativos ao mesmo tempo.
  const [action, setAction] = useState<EditorAction>('idle')
  // Duplicar fica de fora de propósito: ela cria outro rascunho e navega para
  // fora do editor, então nunca entrou no `isBusy` reportado ao pai.
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<SessionFormErrors>({})
  const [loadRevision, setLoadRevision] = useState(0)
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false)
  const publishDialogRef = useRef<HTMLDialogElement>(null)

  const isSaving = action === 'saving'
  const isPublishing = action === 'publishing'
  // Mesmo booleano de antes: `isSaving || isPublishing || isSelectingMovie`.
  const isBusy = action !== 'idle'

  /**
   * Encerra uma operação sem derrubar outra que tenha começado no meio.
   * Equivale ao antigo `setIsSaving(false)`, que zerava apenas a sua própria
   * flag em vez de limpar o estado inteiro.
   */
  const finishAction = useCallback((finished: EditorAction) => {
    setAction((current) => (current === finished ? 'idle' : current))
  }, [])

  const setSelectingMovie = useCallback((isSelecting: boolean) => {
    setAction((current) => {
      if (isSelecting) {
        return 'selecting-movie'
      }

      return current === 'selecting-movie' ? 'idle' : current
    })
  }, [])

  useEffect(() => {
    onBusyChange(isBusy)

    return () => onBusyChange(false)
  }, [isBusy, onBusyChange])

  function updateDirtyState(nextIsDirty: boolean) {
    setIsDirty(nextIsDirty)
    onDirtyChange(nextIsDirty)
  }

  useEffect(() => {
    const dialog = publishDialogRef.current

    if (!dialog) {
      return
    }

    if (isPublishDialogOpen && !dialog.open) {
      dialog.showModal()
      return
    }

    if (!isPublishDialogOpen && dialog.open) {
      dialog.close()
    }
  }, [isPublishDialogOpen])

  useEffect(() => {
    if (!sessionId) {
      return
    }

    const controller = new AbortController()

    getOrganizerSession(accessToken, sessionId, controller.signal)
      .then((loadedSession) => {
        setSession(loadedSession)
        setSelectedMovie(movieFromSession(loadedSession))
        setForm(formFromSession(loadedSession))
        setIsDirty(false)
        onDirtyChange(false)
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setLoadError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Não foi possível carregar a sessão.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      })

    return () => controller.abort()
  }, [accessToken, loadRevision, onDirtyChange, sessionId])

  const isPublishedSession = session?.status === 'PUBLISHED'

  // Reaproveita o canal SSE do P0.2 para manter o painel operacional vivo.
  // Só o snapshot da sessão é atualizado: o formulário em edição nunca é
  // sobrescrito, e o evento continua sendo apenas um sinal de invalidação.
  useEffect(() => {
    if (
      !sessionId ||
      !isPublishedSession ||
      typeof EventSource === 'undefined'
    ) {
      return
    }

    const source = new EventSource(sessionEventsUrl(sessionId))
    let inFlight = false

    function refreshSnapshot() {
      if (inFlight) {
        return
      }

      inFlight = true
      getOrganizerSession(accessToken, sessionId!)
        .then((loadedSession) => setSession(loadedSession))
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }

    source.addEventListener('seats-changed', refreshSnapshot)
    source.addEventListener('session-changed', refreshSnapshot)

    return () => {
      source.removeEventListener('seats-changed', refreshSnapshot)
      source.removeEventListener('session-changed', refreshSnapshot)
      source.close()
    }
  }, [accessToken, isPublishedSession, sessionId])

  function updateField(field: keyof SessionFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    updateDirtyState(true)
    setNotice(null)
    setActionError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setActionError(null)
    setNotice(null)

    const validation = validateForm(form, selectedMovie)
    if (!validation.input) {
      setFieldErrors(validation.errors)
      setActionError('Revise os campos destacados antes de salvar.')
      window.requestAnimationFrame(() => {
        const firstInvalidField =
          document.querySelector<HTMLElement>(
            '.session-form [aria-invalid="true"]',
          ) ??
          document.querySelector<HTMLElement>(
            '.movie-picker button, .movie-picker input',
          )
        firstInvalidField?.focus()
      })
      return
    }

    const input = validation.input
    setFieldErrors({})
    setAction('saving')
    const isNewSession = session === null

    try {
      let savedSession: OrganizerSession

      if (session) {
        const changes = changesFromSession(session, input)

        if (Object.keys(changes).length === 0) {
          updateDirtyState(false)
          setNotice('O rascunho já está atualizado.')
          return
        }

        savedSession = await updateOrganizerSession(
          accessToken,
          session.id,
          changes,
        )
      } else {
        savedSession = await createOrganizerSession(accessToken, input)
      }

      setSession(savedSession)
      setSelectedMovie(movieFromSession(savedSession))
      setForm(formFromSession(savedSession))
      updateDirtyState(false)

      const successMessage = isNewSession
        ? 'Rascunho criado com sucesso. Agora você pode publicá-lo.'
        : 'Rascunho atualizado com sucesso.'

      notify(successMessage, 'success')

      if (isNewSession) {
        onCreated?.(savedSession.id)
      }
    } catch (saveError) {
      setActionError(
        saveError instanceof ApiError
          ? saveError.message
          : 'Não foi possível salvar o rascunho.',
      )
    } finally {
      finishAction('saving')
    }
  }

  async function duplicateThisSession() {
    if (!session || isDuplicating) {
      return
    }

    setIsDuplicating(true)
    setActionError(null)
    setNotice(null)

    try {
      const copy = await duplicateOrganizerSession(accessToken, session.id)
      notify(
        'Cópia criada como rascunho. Revise data e horário antes de publicar.',
        'success',
      )
      // Abre o editor do novo rascunho para a revisão imediata.
      updateDirtyState(false)
      onCreated?.(copy.id)
    } catch (duplicateError) {
      setActionError(
        duplicateError instanceof ApiError
          ? duplicateError.message
          : 'Não foi possível duplicar esta sessão.',
      )
    } finally {
      setIsDuplicating(false)
    }
  }

  async function handlePublish() {
    if (!session) {
      return
    }

    setAction('publishing')
    setActionError(null)
    setNotice(null)

    try {
      const publishedSession = await publishOrganizerSession(
        accessToken,
        session.id,
      )
      setSession(publishedSession)
      setIsPublishDialogOpen(false)
      notify(
        'Sessão publicada e disponível na programação. Ela continua editável até a primeira reserva.',
        'success',
      )
    } catch (publishError) {
      setActionError(
        publishError instanceof ApiError
          ? publishError.message
          : 'Não foi possível publicar a sessão.',
      )
    } finally {
      finishAction('publishing')
    }
  }

  if (isLoading) {
    return (
      <section
        className="organizer-content content-state"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="section-kicker">Carregando</p>
        <h1>Abrindo a sessão…</h1>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="organizer-content content-state error-state">
        <p className="section-kicker">Sessão indisponível</p>
        <h1>Não foi possível abrir este rascunho</h1>
        <p role="alert">{loadError}</p>
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              setIsLoading(true)
              setLoadError(null)
              setLoadRevision((current) => current + 1)
            }}
          >
            Tentar novamente
          </button>
          <button type="button" className="secondary-button" onClick={onBack}>
            Voltar à lista
          </button>
        </div>
      </section>
    )
  }

  const isPublished = session?.status === 'PUBLISHED'
  // Publicar não bloqueia mais por si só: quem decide é a política de
  // editabilidade derivada pelo backend.
  const isStructurallyLocked = Boolean(session && !session.editability.allowed)
  const isLayoutLocked = Boolean(session && !session.editability.layoutEditable)
  const rows = Number(form.rows)
  const seatsPerRow = Number(form.seatsPerRow)
  const priceValue = Number(form.price)
  const pricePreview =
    form.price.trim() && Number.isFinite(priceValue) && priceValue >= 0
      ? formatPrice(Math.round(priceValue * 100))
      : null
  const capacity =
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 10 &&
    Number.isInteger(seatsPerRow) &&
    seatsPerRow >= 1 &&
    seatsPerRow <= 20
      ? rows * seatsPerRow
      : 0
  return (
    <section className="organizer-content" aria-labelledby="editor-title">
      <button
        type="button"
        className="back-button"
        onClick={onBack}
        disabled={isBusy}
      >
        <span aria-hidden="true">←</span> Minhas sessões
      </button>

      <div className="page-heading editor-heading">
        <div>
          <p className="section-kicker">
            {session ? 'Gestão da sessão' : 'Nova programação'}
          </p>
          <h1 id="editor-title">
            {isPublished
              ? 'Detalhes da sessão'
              : session
                ? 'Editar rascunho'
                : 'Criar sessão'}
          </h1>
          <p>
            {isPublished
              ? isStructurallyLocked
                ? 'Consulte os dados publicados em modo de leitura.'
                : 'Sessão publicada, ainda sem reservas: os dados continuam editáveis.'
              : 'Escolha o filme e configure apenas o necessário para a exibição.'}
          </p>
        </div>
        {isDirty || session ? (
          <div className="button-row">
            {isDirty ? (
              <span className="status-badge status-draft" role="status">
                Alterações não salvas
              </span>
            ) : null}
            {session ? (
              <span
                className={`status-badge status-${session.status.toLowerCase()}`}
              >
                {isPublished ? 'Publicada' : 'Rascunho'}
              </span>
            ) : null}
            {session ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void duplicateThisSession()}
                disabled={isBusy || isDuplicating}
              >
                {isDuplicating ? 'Duplicando…' : 'Duplicar sessão'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {notice ? (
        <p className="message success-message" role="status">
          {notice}
        </p>
      ) : null}

      {actionError && !isPublishDialogOpen ? (
        <p className="message error-message" role="alert">
          {actionError}
        </p>
      ) : null}

      {session && isPublished ? (
        <SessionOperationsPanel session={session} />
      ) : null}

      {isStructurallyLocked && session ? (
        <PublishedSession session={session} />
      ) : (
        <>
          {isPublished ? (
            <p className="editable-published-notice">
              <span aria-hidden="true">●</span>
              <span>
                <strong>Sessão publicada e ainda editável.</strong>
                {isLayoutLocked
                  ? ' Nenhuma reserva ou ingresso está ativo nesta sessão, então filme, horário, local e preço ainda podem ser alterados. Só o mapa de assentos ficou travado, porque lugares desta sessão já foram reservados antes.'
                  : ' Nenhuma reserva ou ingresso depende desta estrutura, então filme, horário, local, preço e layout ainda podem ser alterados.'}
                {' '}
                Assim que alguém reservar, a edição é bloqueada.
              </span>
            </p>
          ) : null}
          <MoviePicker
            accessToken={accessToken}
            disabled={isBusy}
            selectedMovie={selectedMovie}
            onSelect={(movie) => {
              setSelectedMovie(movie)
              setFieldErrors((current) => {
                const next = { ...current }
                delete next.movie
                return next
              })
              updateDirtyState(true)
              setNotice(null)
              setActionError(null)
            }}
            onSelectionBusyChange={setSelectingMovie}
          />

          {fieldErrors.movie ? (
            <p className="field-error movie-picker-error">
              {fieldErrors.movie}
            </p>
          ) : null}

          <form
            className="session-form"
            aria-busy={isBusy}
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="form-section-heading">
              <p className="section-kicker">Passo 2</p>
              <h2>Configure a exibição</h2>
            </div>

            <div className="form-grid">
              <div className="field field-wide">
                <label htmlFor="starts-at">Data e hora</label>
                <input
                  id="starts-at"
                  type="datetime-local"
                  value={form.startsAt}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('startsAt', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.startsAt)}
                  aria-describedby={
                    fieldErrors.startsAt ? 'starts-at-error' : undefined
                  }
                  required
                />
                {fieldErrors.startsAt ? (
                  <p id="starts-at-error" className="field-error">
                    {fieldErrors.startsAt}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="venue-name">Cinema / local</label>
                <input
                  id="venue-name"
                  value={form.venueName}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('venueName', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.venueName)}
                  aria-describedby={
                    fieldErrors.venueName ? 'venue-name-error' : undefined
                  }
                  maxLength={120}
                  placeholder="Ex.: SEPTEM Paulista"
                  required
                />
                {fieldErrors.venueName ? (
                  <p id="venue-name-error" className="field-error">
                    {fieldErrors.venueName}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="room-name">Sala</label>
                <input
                  id="room-name"
                  value={form.roomName}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('roomName', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.roomName)}
                  aria-describedby={
                    fieldErrors.roomName ? 'room-name-error' : undefined
                  }
                  maxLength={80}
                  placeholder="Ex.: Sala 2"
                  required
                />
                {fieldErrors.roomName ? (
                  <p id="room-name-error" className="field-error">
                    {fieldErrors.roomName}
                  </p>
                ) : null}
              </div>

              <div className="field field-wide">
                <label htmlFor="address">Endereço</label>
                <input
                  id="address"
                  value={form.address}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('address', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.address)}
                  aria-describedby={
                    fieldErrors.address ? 'address-error' : undefined
                  }
                  maxLength={240}
                  placeholder="Rua, número e cidade"
                  required
                />
                {fieldErrors.address ? (
                  <p id="address-error" className="field-error">
                    {fieldErrors.address}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="price">Preço do ingresso (R$)</label>
                <input
                  id="price"
                  type="number"
                  value={form.price}
                  disabled={isBusy}
                  min="0"
                  max="100000"
                  step="0.01"
                  onChange={(event) => updateField('price', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.price)}
                  aria-describedby={
                    fieldErrors.price
                      ? 'price-error'
                      : pricePreview
                        ? 'price-preview'
                        : undefined
                  }
                  placeholder="30,00"
                  required
                />
                {fieldErrors.price ? (
                  <p id="price-error" className="field-error">
                    {fieldErrors.price}
                  </p>
                ) : pricePreview ? (
                  <small id="price-preview" className="field-hint">
                    Valor exibido: {pricePreview}
                  </small>
                ) : null}
              </div>
            </div>

            <fieldset className="layout-fieldset">
              <legend>Layout da sala</legend>
              <p id="layout-hint">
                {isLayoutLocked
                  ? 'Os lugares desta sessão já foram reservados alguma vez. O mapa não pode ser reconstruído sem apagar esse histórico; os demais campos continuam editáveis.'
                  : 'Os lugares serão gerados de A1 em diante. O layout pode ser alterado enquanto nenhum lugar tiver sido reservado.'}
              </p>
              <div className="layout-configurator">
                <div className="layout-fields">
                  <div className="field">
                    <label htmlFor="rows">Fileiras</label>
                    <input
                      id="rows"
                      type="number"
                      value={form.rows}
                      disabled={isBusy || isLayoutLocked}
                      min="1"
                      max="10"
                      onChange={(event) =>
                        updateField('rows', event.target.value)
                      }
                      aria-invalid={Boolean(fieldErrors.rows)}
                      aria-describedby={
                        fieldErrors.rows
                          ? 'rows-error layout-hint'
                          : 'layout-hint'
                      }
                      required
                    />
                    {fieldErrors.rows ? (
                      <p id="rows-error" className="field-error">
                        {fieldErrors.rows}
                      </p>
                    ) : null}
                  </div>
                  <span aria-hidden="true">×</span>
                  <div className="field">
                    <label htmlFor="seats-per-row">Assentos por fileira</label>
                    <input
                      id="seats-per-row"
                      type="number"
                      value={form.seatsPerRow}
                      disabled={isBusy || isLayoutLocked}
                      min="1"
                      max="20"
                      onChange={(event) =>
                        updateField('seatsPerRow', event.target.value)
                      }
                      aria-invalid={Boolean(fieldErrors.seatsPerRow)}
                      aria-describedby={
                        fieldErrors.seatsPerRow
                          ? 'seats-per-row-error layout-hint'
                          : 'layout-hint'
                      }
                      required
                    />
                    {fieldErrors.seatsPerRow ? (
                      <p id="seats-per-row-error" className="field-error">
                        {fieldErrors.seatsPerRow}
                      </p>
                    ) : null}
                  </div>
                  <div className="capacity-summary" aria-live="polite">
                    <strong>{capacity}</strong>
                    <span>lugares</span>
                  </div>
                </div>
                <RoomLayoutPreview rows={rows} seatsPerRow={seatsPerRow} />
              </div>
            </fieldset>

            <div className="editor-actions">
              <button type="submit" disabled={isBusy}>
                {isSaving
                  ? 'Salvando…'
                  : session
                    ? 'Salvar alterações'
                    : 'Salvar rascunho'}
              </button>
              {session ? (
                <div className="publish-action">
                  <p>Revise e salve qualquer alteração antes de publicar.</p>
                  <button
                    type="button"
                    className="publish-button"
                    onClick={() => {
                      setActionError(null)
                      setIsPublishDialogOpen(true)
                    }}
                    disabled={isBusy || isDirty}
                  >
                    Publicar sessão
                  </button>
                </div>
              ) : null}
            </div>
          </form>
        </>
      )}

      {session && !isPublished ? (
        <dialog
          ref={publishDialogRef}
          className="organizer-publish-dialog"
          aria-labelledby="publish-dialog-title"
          aria-describedby="publish-dialog-description"
          aria-busy={isPublishing}
          onCancel={(event) => {
            if (isPublishing) {
              event.preventDefault()
              return
            }

            setIsPublishDialogOpen(false)
          }}
          onClose={() => setIsPublishDialogOpen(false)}
        >
          <div className="publish-dialog-content">
            <p className="section-kicker">Publicação definitiva</p>
            <h2 id="publish-dialog-title">Publicar esta sessão?</h2>
            <p id="publish-dialog-description">
              Confira os dados principais antes de disponibilizar a sessão na
              programação.
            </p>

            <dl className="publish-dialog-summary">
              <div>
                <dt>Filme</dt>
                <dd>{session.movie.title}</dd>
              </div>
              <div>
                <dt>Data e hora</dt>
                <dd>{formatSessionDate(session.startsAt)}</dd>
              </div>
              <div>
                <dt>Local</dt>
                <dd>
                  {session.venueName} · {session.roomName}
                </dd>
              </div>
              <div>
                <dt>Ingresso</dt>
                <dd>{formatPrice(session.priceCents)}</dd>
              </div>
              <div>
                <dt>Capacidade</dt>
                <dd>{session.capacity} lugares</dd>
              </div>
            </dl>

            <p className="publish-dialog-warning">
              <strong>Após publicar,</strong> a sessão entra na programação
              pública. Filme, horário, preço, local e assentos continuam
              editáveis até a primeira reserva ou ingresso.
            </p>

            {actionError ? (
              <p className="message error-message" role="alert">
                {actionError}
              </p>
            ) : null}

            <div className="publish-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={isPublishing}
                onClick={() => setIsPublishDialogOpen(false)}
              >
                Voltar e revisar
              </button>
              <button
                type="button"
                className="publish-button"
                disabled={isPublishing}
                onClick={() => void handlePublish()}
              >
                {isPublishing ? 'Publicando…' : 'Confirmar publicação'}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </section>
  )
}
