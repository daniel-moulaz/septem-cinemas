import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ApiError,
  getPublicSessions,
  type PublicSessionSummary,
} from '../../api'
import { PosterImage } from '../common/PosterImage'
import { ServerStartingNotice } from '../common/ServerStartingNotice'
import {
  formatCompactSessionDay,
  formatPrice,
  formatSessionDay,
  formatSessionTime,
  movieYear,
  tmdbBackdropUrl,
  tmdbPosterUrl,
} from '../organizer/formatters'

interface PublicCatalogProps {
  onOpenSession: (sessionId: string) => void
}

interface SessionDateOption {
  key: string
  startsAt: string
}

interface VenueProgram {
  key: string
  venueName: string
  roomName: string
  sessions: PublicSessionSummary[]
}

interface MovieProgram {
  key: string
  movie: PublicSessionSummary['movie']
  firstSession: PublicSessionSummary
  sessions: PublicSessionSummary[]
  venues: VenueProgram[]
  minimumPriceCents: number
  hasDifferentPrices: boolean
}

const weekdayFormatter = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
})

const dayFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
})

const monthFormatter = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
})

const catalogContextKey = 'septem-catalog-context'

interface CatalogContext {
  query: string
  dateKey: string
  venueName: string
  featuredMovieId: number | null
}

function readCatalogContext(): CatalogContext {
  const emptyContext: CatalogContext = {
    query: '',
    dateKey: '',
    venueName: '',
    featuredMovieId: null,
  }

  let storedContext = emptyContext

  try {
    const storedValue = sessionStorage.getItem(catalogContextKey)

    if (storedValue) {
      const parsed = JSON.parse(storedValue) as Partial<CatalogContext>

      storedContext = {
        query: typeof parsed.query === 'string' ? parsed.query : '',
        dateKey: typeof parsed.dateKey === 'string' ? parsed.dateKey : '',
        venueName:
          typeof parsed.venueName === 'string' ? parsed.venueName : '',
        featuredMovieId:
          typeof parsed.featuredMovieId === 'number' &&
          Number.isSafeInteger(parsed.featuredMovieId) &&
          parsed.featuredMovieId > 0
            ? parsed.featuredMovieId
            : null,
      }
    }
  } catch {
    storedContext = emptyContext
  }

  const params = new URLSearchParams(window.location.search)
  const movieParam = Number(params.get('movie'))

  return {
    query: params.has('q')
      ? (params.get('q') ?? '').trim().slice(0, 120)
      : storedContext.query,
    dateKey: params.has('date')
      ? (params.get('date') ?? '')
      : storedContext.dateKey,
    venueName: params.has('cinema')
      ? (params.get('cinema') ?? '').trim().slice(0, 120)
      : storedContext.venueName,
    featuredMovieId:
      params.has('movie') && Number.isSafeInteger(movieParam) && movieParam > 0
        ? movieParam
        : storedContext.featuredMovieId,
  }
}

function readUrlCatalogContext(): CatalogContext {
  const params = new URLSearchParams(window.location.search)
  const movieParam = Number(params.get('movie'))

  return {
    query: (params.get('q') ?? '').trim().slice(0, 120),
    dateKey: params.get('date') ?? '',
    venueName: (params.get('cinema') ?? '').trim().slice(0, 120),
    featuredMovieId:
      params.has('movie') && Number.isSafeInteger(movieParam) && movieParam > 0
        ? movieParam
        : null,
  }
}

function localDateKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function dateOptions(sessions: PublicSessionSummary[]): SessionDateOption[] {
  const dates = new Map<string, string>()

  for (const session of sessions) {
    const key = localDateKey(session.startsAt)

    if (!dates.has(key)) {
      dates.set(key, session.startsAt)
    }
  }

  return Array.from(dates, ([key, startsAt]) => ({ key, startsAt }))
}

function movieGroupKey(session: PublicSessionSummary): string {
  return String(session.movie.tmdbId)
}

function groupSessionsByMovie(
  sessions: PublicSessionSummary[],
): MovieProgram[] {
  const movieGroups = new Map<
    string,
    {
      movie: PublicSessionSummary['movie']
      sessions: PublicSessionSummary[]
    }
  >()

  for (const session of sessions) {
    const key = movieGroupKey(session)
    const group = movieGroups.get(key)

    if (group) {
      group.sessions.push(session)
    } else {
      movieGroups.set(key, {
        movie: session.movie,
        sessions: [session],
      })
    }
  }

  return Array.from(movieGroups, ([key, group]) => {
    const venueGroups = new Map<string, VenueProgram>()
    const prices = new Set<number>()

    for (const session of group.sessions) {
      const venueKey = `${session.venueName}\u0000${session.roomName}`
      const venue = venueGroups.get(venueKey)

      prices.add(session.priceCents)

      if (venue) {
        venue.sessions.push(session)
      } else {
        venueGroups.set(venueKey, {
          key: venueKey,
          venueName: session.venueName,
          roomName: session.roomName,
          sessions: [session],
        })
      }
    }

    return {
      key,
      movie: group.movie,
      // Cada grupo nasce com a sessão que o criou.
      firstSession: group.sessions[0]!,
      sessions: group.sessions,
      venues: Array.from(venueGroups.values()),
      minimumPriceCents: Math.min(...prices),
      hasDifferentPrices: prices.size > 1,
    }
  })
}

function dateTabLabels(startsAt: string) {
  const date = new Date(startsAt)
  const isToday = localDateKey(date) === localDateKey(new Date())
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = localDateKey(date) === localDateKey(tomorrow)

  return {
    weekday: isToday
      ? 'Hoje'
      : isTomorrow
        ? 'Amanhã'
      : weekdayFormatter.format(date).replace('.', ''),
    day: dayFormatter.format(date),
    month: monthFormatter.format(date).replace('.', ''),
  }
}

export function PublicCatalog({ onOpenSession }: PublicCatalogProps) {
  const [initialContext] = useState(readCatalogContext)
  const restoredFeaturedMovieId = useRef(initialContext.featuredMovieId)
  const railRef = useRef<HTMLDivElement>(null)
  const [queryInput, setQueryInput] = useState(initialContext.query)
  const [activeQuery, setActiveQuery] = useState(initialContext.query)
  const [selectedDateKey, setSelectedDateKey] = useState(
    initialContext.dateKey,
  )
  const [selectedVenueName, setSelectedVenueName] = useState(
    initialContext.venueName,
  )
  const [sessions, setSessions] = useState<PublicSessionSummary[]>([])
  const [catalogSessions, setCatalogSessions] = useState<
    PublicSessionSummary[]
  >([])
  const [featuredSession, setFeaturedSession] =
    useState<PublicSessionSummary | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [catalogStatus, setCatalogStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [catalogReloadKey, setCatalogReloadKey] = useState(0)
  const [railOverflow, setRailOverflow] = useState({
    previous: false,
    next: false,
  })
  const activeQueryRef = useRef(activeQuery)

  useEffect(() => {
    activeQueryRef.current = activeQuery
  }, [activeQuery])

  useEffect(() => {
    const controller = new AbortController()

    getPublicSessions('', controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        const sortedSessions = [...result].sort(
          (first, second) =>
            new Date(first.startsAt).getTime() -
            new Date(second.startsAt).getTime(),
        )
        setCatalogSessions(sortedSessions)
        setCatalogStatus('ready')
        setFeaturedSession((current) => {
          const restoredSession = restoredFeaturedMovieId.current
            ? sortedSessions.find(
                (session) =>
                  session.movie.tmdbId === restoredFeaturedMovieId.current,
              )
            : null

          const nextSession =
            restoredSession ??
            (current
              ? sortedSessions.find(
                  (session) =>
                    movieGroupKey(session) === movieGroupKey(current),
                )
              : null) ??
            sortedSessions[0] ??
            null

          restoredFeaturedMovieId.current = nextSession?.movie.tmdbId ?? null
          return nextSession
        })

        if (!activeQueryRef.current) {
          setSessions(sortedSessions)
          setStatus('ready')
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setCatalogStatus('error')
        if (!activeQueryRef.current) {
          setErrorMessage(
            error instanceof ApiError
              ? error.message
              : 'Não foi possível carregar a programação.',
          )
          setStatus('error')
        }
      })

    return () => controller.abort()
  }, [catalogReloadKey])

  useEffect(() => {
    if (!activeQuery) {
      return
    }

    const controller = new AbortController()

    getPublicSessions(activeQuery, controller.signal)
      .then((result) => {
        if (
          controller.signal.aborted ||
          activeQueryRef.current !== activeQuery
        ) {
          return
        }

        const sortedSessions = [...result].sort(
          (first, second) =>
            new Date(first.startsAt).getTime() -
            new Date(second.startsAt).getTime(),
        )
        setSessions(sortedSessions)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          activeQueryRef.current !== activeQuery
        ) {
          return
        }

        setErrorMessage(
          error instanceof ApiError
            ? error.message
            : 'Não foi possível concluir a busca.',
        )
        setStatus('error')
      })

    return () => controller.abort()
  }, [activeQuery, reloadKey])

  useEffect(() => {
    function handlePopState() {
      const nextContext = readUrlCatalogContext()

      restoredFeaturedMovieId.current = nextContext.featuredMovieId
      setQueryInput(nextContext.query)
      setSelectedDateKey(nextContext.dateKey)
      setSelectedVenueName(nextContext.venueName)
      setErrorMessage('')

      if (nextContext.query !== activeQuery) {
        if (nextContext.query) {
          setStatus('loading')
        } else if (catalogSessions.length > 0) {
          setSessions(catalogSessions)
          setStatus('ready')
        } else {
          setStatus('loading')
          if (catalogStatus !== 'loading') {
            setCatalogStatus('loading')
            setCatalogReloadKey((value) => value + 1)
          }
        }
        activeQueryRef.current = nextContext.query
        setActiveQuery(nextContext.query)
      }

      setFeaturedSession(
        catalogSessions.find(
          (session) =>
            session.movie.tmdbId === nextContext.featuredMovieId,
        ) ?? catalogSessions[0] ?? null,
      )
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [activeQuery, catalogSessions, catalogStatus])

  useEffect(() => {
    const nextContext = {
      query: activeQuery,
      dateKey: selectedDateKey,
      venueName: selectedVenueName,
      featuredMovieId:
        featuredSession?.movie.tmdbId ?? restoredFeaturedMovieId.current,
    } satisfies CatalogContext

    try {
      sessionStorage.setItem(
        catalogContextKey,
        JSON.stringify(nextContext),
      )
    } catch {
      // A navegação continua funcional quando o navegador bloqueia storage.
    }

    const url = new URL(window.location.href)
    const urlValues = {
      q: nextContext.query,
      date: nextContext.dateKey,
      cinema: nextContext.venueName,
      movie: nextContext.featuredMovieId?.toString() ?? '',
    }

    for (const [name, value] of Object.entries(urlValues)) {
      if (value) {
        url.searchParams.set(name, value)
      } else {
        url.searchParams.delete(name)
      }
    }

    const nextRelativeUrl = `${url.pathname}${url.search}${url.hash}`
    const currentRelativeUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`

    if (nextRelativeUrl !== currentRelativeUrl) {
      window.history.replaceState(window.history.state, '', nextRelativeUrl)
    }
  }, [activeQuery, featuredSession, selectedDateKey, selectedVenueName])

  const updateRailOverflow = useCallback(() => {
    const rail = railRef.current

    if (!rail) {
      return
    }

    const edgeTolerance = 2
    const nextOverflow = {
      previous: rail.scrollLeft > edgeTolerance,
      next:
        rail.scrollLeft + rail.clientWidth <
        rail.scrollWidth - edgeTolerance,
    }

    setRailOverflow((current) =>
      current.previous === nextOverflow.previous &&
      current.next === nextOverflow.next
        ? current
        : nextOverflow,
    )
  }, [])

  useEffect(() => {
    const rail = railRef.current

    if (!rail) {
      return
    }

    updateRailOverflow()
    const resizeObserver = new ResizeObserver(updateRailOverflow)
    resizeObserver.observe(rail)
    rail.addEventListener('scroll', updateRailOverflow, { passive: true })

    return () => {
      resizeObserver.disconnect()
      rail.removeEventListener('scroll', updateRailOverflow)
    }
  }, [catalogSessions, updateRailOverflow])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextQuery = queryInput.trim()
    setErrorMessage('')
    setSelectedDateKey('')

    if (!nextQuery) {
      if (activeQuery) {
        activeQueryRef.current = ''
        setActiveQuery('')
      }

      if (catalogSessions.length > 0) {
        setSessions(catalogSessions)
        setStatus('ready')
      } else {
        setStatus('loading')
        if (catalogStatus !== 'loading') {
          setCatalogStatus('loading')
          setCatalogReloadKey((value) => value + 1)
        }
      }
      return
    }

    setStatus('loading')
    if (nextQuery === activeQuery) {
      setReloadKey((value) => value + 1)
    } else {
      activeQueryRef.current = nextQuery
      setActiveQuery(nextQuery)
    }
  }

  function clearSearch() {
    setQueryInput('')
    setErrorMessage('')
    setSelectedDateKey('')

    if (activeQuery) {
      activeQueryRef.current = ''
      setActiveQuery('')
    }

    if (catalogSessions.length > 0) {
      setSessions(catalogSessions)
      setStatus('ready')
    } else {
      setStatus('loading')
      if (catalogStatus !== 'loading') {
        setCatalogStatus('loading')
        setCatalogReloadKey((value) => value + 1)
      }
    }
  }

  function clearFilters() {
    setQueryInput('')
    setSelectedDateKey('')
    setSelectedVenueName('')
    setErrorMessage('')

    if (activeQuery) {
      activeQueryRef.current = ''
      setActiveQuery('')
    }

    if (catalogSessions.length > 0) {
      setSessions(catalogSessions)
      setStatus('ready')
    } else {
      setStatus('loading')
      if (catalogStatus !== 'loading') {
        setCatalogStatus('loading')
        setCatalogReloadKey((value) => value + 1)
      }
    }
  }

  function moveRail(direction: -1 | 1) {
    const rail = railRef.current

    if (!rail) {
      return
    }

    rail.scrollBy({
      left: direction * rail.clientWidth * 0.72,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }

  function retry() {
    setStatus('loading')
    setErrorMessage('')
    if (catalogSessions.length === 0) {
      setCatalogStatus('loading')
      setCatalogReloadKey((value) => value + 1)
    }
    if (activeQuery) {
      setReloadKey((value) => value + 1)
    }
  }

  const venueNames = Array.from(
    new Set(sessions.map((session) => session.venueName)),
  ).sort((first, second) => first.localeCompare(second, 'pt-BR'))
  const hasValidSelectedVenue =
    !selectedVenueName || venueNames.includes(selectedVenueName)
  const effectiveVenueName = hasValidSelectedVenue
    ? selectedVenueName
    : ''
  const venueSessions = effectiveVenueName
    ? sessions.filter((session) => session.venueName === effectiveVenueName)
    : sessions
  const availableDates = dateOptions(venueSessions)
  const hasValidSelectedDate = availableDates.some(
    (option) => option.key === selectedDateKey,
  )
  const effectiveDateKey = hasValidSelectedDate
    ? selectedDateKey
    : (availableDates[0]?.key ?? '')
  const selectedDate = availableDates.find(
    (option) => option.key === effectiveDateKey,
  )
  const selectedSessions = venueSessions.filter(
    (session) => localDateKey(session.startsAt) === effectiveDateKey,
  )
  const moviePrograms = groupSessionsByMovie(selectedSessions)
  const catalogMovies = groupSessionsByMovie(catalogSessions)
  const featuredProgram = featuredSession
    ? catalogMovies.find(
        (program) => program.movie.tmdbId === featuredSession.movie.tmdbId,
      )
    : undefined
  const featuredShowtimes = featuredProgram
    ? featuredProgram.sessions.filter(
        (session) =>
          session.venueName === featuredProgram.firstSession.venueName &&
          session.roomName === featuredProgram.firstSession.roomName &&
          localDateKey(session.startsAt) ===
            localDateKey(featuredProgram.firstSession.startsAt),
      )
    : []
  const stageShowtimes =
    featuredShowtimes.length > 0
      ? featuredShowtimes
      : featuredSession
        ? [featuredSession]
        : []
  const stageMinimumPriceCents =
    stageShowtimes.length > 0
      ? Math.min(...stageShowtimes.map((session) => session.priceCents))
      : null
  const stageHasDifferentPrices =
    new Set(stageShowtimes.map((session) => session.priceCents)).size > 1
  const featuredPosterUrl = featuredSession
    ? tmdbPosterUrl(featuredSession.movie.posterPath)
    : null
  const featuredBackdropUrl = featuredSession
    ? tmdbBackdropUrl(featuredSession.movie.backdropPath)
    : null
  const featuredMovieKey = featuredSession
    ? movieGroupKey(featuredSession)
    : null
  const activeMovieIndex = catalogMovies.findIndex(
    (program) => program.key === featuredMovieKey,
  )
  const programmingContext =
    effectiveVenueName ||
    (venueNames.length === 1
      ? venueNames[0]
      : `${venueNames.length} cinemas na programação`)
  const hasActiveFilters = Boolean(
    activeQuery ||
      effectiveVenueName ||
      (selectedDateKey && selectedDateKey === effectiveDateKey),
  )

  function activateMovie(
    program: MovieProgram,
    railItem?: HTMLButtonElement,
  ) {
    restoredFeaturedMovieId.current = program.movie.tmdbId
    setFeaturedSession(program.firstSession)
    railItem?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'nearest',
      inline: 'center',
    })
  }

  function handleRailKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    movieIndex: number,
  ) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }

    const nextIndex =
      event.key === 'ArrowLeft' ? movieIndex - 1 : movieIndex + 1
    const nextProgram = catalogMovies[nextIndex]
    const nextItem = railRef.current?.querySelectorAll<HTMLButtonElement>(
      '.poster-rail-item',
    )[nextIndex]

    if (!nextProgram || !nextItem) {
      return
    }

    event.preventDefault()
    activateMovie(nextProgram, nextItem)
    nextItem.focus()
  }

  return (
    <div className="public-content catalog-page">
      <h1 className="visually-hidden">Programação SEPTEM Cinemas</h1>
      {status === 'loading' ? <ServerStartingNotice /> : null}

      {catalogStatus === 'loading' && !featuredSession ? (
        <section
          className="cinematic-stage cinematic-stage-loading"
          aria-busy="true"
          aria-live="polite"
        >
          <p className="visually-hidden">Carregando filme em destaque…</p>
          <div className="stage-loading-inner" aria-hidden="true">
            <div className="stage-loading-poster" />
            <div className="stage-loading-copy">
              <span /><span /><span />
            </div>
          </div>
        </section>
      ) : null}

      {featuredSession ? (
        <section
          className="cinematic-stage"
          aria-labelledby="featured-movie-title"
        >
          <div
            key={featuredSession.movie.tmdbId}
            className="stage-atmosphere"
            style={
              featuredBackdropUrl || featuredPosterUrl
                ? {
                    backgroundImage: `url("${featuredBackdropUrl ?? featuredPosterUrl}")`,
                  }
                : undefined
            }
            aria-hidden="true"
          />
          <div className="stage-inner">
            <PosterImage
              className="stage-poster"
              src={featuredPosterUrl}
              title={featuredSession.movie.title}
              loading="eager"
              variant="hero"
            />
            <div className="stage-copy">
              <p className="stage-kicker">Agora na SEPTEM</p>
              <h2 id="featured-movie-title">{featuredSession.movie.title}</h2>
              <p className="stage-meta">
                {featuredSession.movie.releaseDate ? (
                  <span>{movieYear(featuredSession.movie.releaseDate)}</span>
                ) : null}
                {featuredSession.movie.runtimeMinutes ? (
                  <span>{featuredSession.movie.runtimeMinutes} min</span>
                ) : null}
                {stageMinimumPriceCents !== null ? (
                  <span>
                    {stageHasDifferentPrices ? 'A partir de ' : 'Ingresso '}
                    {formatPrice(stageMinimumPriceCents)}
                  </span>
                ) : null}
              </p>
              <p className="stage-location">
                <strong>{featuredSession.venueName}</strong>
                <span>{featuredSession.roomName}</span>
              </p>
              <div className="stage-next-session stage-showtimes">
                <div className="stage-showtimes-heading">
                  <span>Próximas sessões</span>
                  <small>
                    {formatCompactSessionDay(featuredSession.startsAt)}
                  </small>
                </div>
                <div className="stage-showtime-list">
                  {stageShowtimes.map((session) => (
                    <button
                      type="button"
                      className="stage-showtime-button"
                      key={session.id}
                      onClick={() => onOpenSession(session.id)}
                      aria-label={`Escolher lugares para ${session.movie.title}, em ${formatSessionDay(session.startsAt)}, às ${formatSessionTime(session.startsAt)}, ${session.venueName}, ${session.roomName}, ${formatPrice(session.priceCents)}`}
                    >
                      <time dateTime={session.startsAt}>
                        {formatSessionTime(session.startsAt)}
                      </time>
                      <span>
                        {formatPrice(session.priceCents)}
                        <span className="stage-showtime-cta">
                          {' '}
                          · escolher lugares
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {catalogStatus === 'loading' && catalogMovies.length === 0 ? (
        <section className="poster-rail-section poster-rail-loading">
          <div className="poster-rail-heading">
            <p>SEPTEM Cinemas</p>
            <h2>Em cartaz</h2>
          </div>
          <div className="poster-rail-skeleton" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
        </section>
      ) : null}

      {catalogMovies.length > 0 ? (
        <section className="poster-rail-section" aria-labelledby="poster-rail-title">
          <header className="poster-rail-heading">
            <div>
              <p>SEPTEM Cinemas</p>
              <h2 id="poster-rail-title">Em cartaz</h2>
            </div>
            {railOverflow.previous || railOverflow.next ? (
              <div className="poster-rail-controls" aria-label="Navegar pelos filmes">
                <button
                  type="button"
                  onClick={() => moveRail(-1)}
                  disabled={!railOverflow.previous}
                  aria-label="Filmes anteriores"
                >
                  <span aria-hidden="true">←</span>
                </button>
                <button
                  type="button"
                  onClick={() => moveRail(1)}
                  disabled={!railOverflow.next}
                  aria-label="Próximos filmes"
                >
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            ) : null}
          </header>
          <p className="visually-hidden" role="status" aria-live="polite">
            {featuredSession
              ? `Filme em destaque: ${featuredSession.movie.title}`
              : ''}
          </p>
          <div
            ref={railRef}
            className={`poster-rail ${
              !railOverflow.previous && !railOverflow.next
                ? 'is-contained'
                : ''
            }`.trim()}
            aria-label="Filmes em cartaz"
          >
            {catalogMovies.map((program, movieIndex) => {
              const isActive = program.key === featuredMovieKey
              const distanceFromActive =
                activeMovieIndex === -1 ? 0 : movieIndex - activeMovieIndex
              const positionClass = isActive
                ? 'is-active'
                : Math.abs(distanceFromActive) === 1
                  ? 'is-adjacent'
                  : 'is-distant'
              const sideClass =
                distanceFromActive < 0
                  ? 'is-before'
                  : distanceFromActive > 0
                    ? 'is-after'
                    : ''
              const posterUrl = tmdbPosterUrl(program.movie.posterPath)

              return (
                <button
                  type="button"
                  className={`poster-rail-item ${positionClass} ${sideClass}`.trim()}
                  key={program.key}
                  aria-pressed={isActive}
                  data-distance={distanceFromActive}
                  onKeyDown={(event) =>
                    handleRailKeyDown(event, movieIndex)
                  }
                  onClick={(event) => {
                    activateMovie(program, event.currentTarget)
                  }}
                >
                  <span className="poster-rail-frame">
                    <PosterImage
                      className="poster-rail-poster"
                      src={posterUrl}
                      title={program.movie.title}
                      decorative
                    />
                  </span>
                  <span className="poster-rail-caption">
                    <strong>{program.movie.title}</strong>{' '}
                    <small>
                      {isActive
                        ? 'Em destaque'
                        : program.movie.releaseDate
                          ? movieYear(program.movie.releaseDate)
                          : 'Em cartaz'}
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <section
        className="programming-board"
        id="programming"
        aria-labelledby="programming-title"
      >
        <div className="programming-board-inner">
          <header className="programming-toolbar">
            <div>
              <p className="section-kicker">
                {status === 'ready' && sessions.length > 0
                  ? programmingContext
                  : 'SEPTEM Cinemas'}
              </p>
              <h2 id="programming-title">Programação</h2>
            </div>

            <form className="program-search" onSubmit={handleSearch} role="search">
              <label className="visually-hidden" htmlFor="session-search">
                Buscar por filme ou cinema
              </label>
              <input
                id="session-search"
                type="search"
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="Buscar filme ou cinema"
                maxLength={120}
                disabled={status === 'loading'}
              />
              <button type="submit" disabled={status === 'loading'}>
                Buscar
              </button>
            </form>
          </header>

          {activeQuery && status === 'ready' ? (
            <div className="search-context">
              <p>
                {sessions.length}{' '}
                {sessions.length === 1 ? 'sessão encontrada' : 'sessões encontradas'}
                {' '}para <strong>“{activeQuery}”</strong>
              </p>
              <button type="button" className="text-button" onClick={clearSearch}>
                Limpar busca
              </button>
            </div>
          ) : null}

          {status === 'ready' && sessions.length > 0 ? (
            <div className="catalog-filters" aria-label="Filtros da programação">
              <label htmlFor="venue-filter">Cinema</label>
              <select
                id="venue-filter"
                value={effectiveVenueName}
                onChange={(event) => {
                  setSelectedVenueName(event.target.value)
                  setSelectedDateKey('')
                }}
              >
                <option value="">Todos os cinemas</option>
                {venueNames.map((venueName) => (
                  <option key={venueName} value={venueName}>
                    {venueName}
                  </option>
                ))}
              </select>
              {hasActiveFilters ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={clearFilters}
                >
                  Limpar filtros
                </button>
              ) : null}
            </div>
          ) : null}

          {status === 'loading' ? (
            <div className="program-loading" aria-busy="true" aria-live="polite">
              <p className="visually-hidden">Carregando programação…</p>
              <div className="date-strip-loading" aria-hidden="true">
                <span /><span /><span /><span />
              </div>
              {[0, 1].map((item) => (
                <div className="movie-program-skeleton" key={item} aria-hidden="true">
                  <span />
                  <div><span /><span /><span /></div>
                </div>
              ))}
            </div>
          ) : null}

          {status === 'error' ? (
            <div className="content-state public-state" role="alert">
              <p className="section-kicker">Não foi possível carregar</p>
              <h3>
                {activeQuery
                  ? 'Não foi possível concluir a busca.'
                  : 'Não foi possível atualizar a programação.'}
              </h3>
              <p>
                {errorMessage}
                {!activeQuery && catalogSessions.length > 0
                  ? ' Os filmes acima são do último carregamento concluído.'
                  : ''}
              </p>
              <button type="button" onClick={retry}>
                Tentar novamente
              </button>
            </div>
          ) : null}

          {status === 'ready' && sessions.length === 0 ? (
            <div className="content-state public-state empty-state">
              <p className="visually-hidden" role="status">
                {activeQuery
                  ? 'Nenhum resultado encontrado para a busca.'
                  : 'Nenhuma sessão publicada no momento.'}
              </p>
              <span className="state-symbol" aria-hidden="true">○</span>
              <h3>
                {activeQuery
                  ? `Nenhum resultado para “${activeQuery}”.`
                  : 'Ainda não há sessões publicadas.'}
              </h3>
              <p>
                {activeQuery
                  ? 'Tente outro filme, cinema ou limpe a busca.'
                  : 'Volte em breve para conferir a próxima programação.'}
              </p>
              {activeQuery ? (
                <button type="button" onClick={clearFilters}>Ver toda a programação</button>
              ) : null}
            </div>
          ) : null}

          {status === 'ready' && sessions.length > 0 ? (
            <>
              <div
                className="date-selector"
                role="group"
                aria-label="Escolha a data da programação"
              >
                {availableDates.map((option) => {
                  const labels = dateTabLabels(option.startsAt)
                  const isSelected = option.key === effectiveDateKey

                  return (
                    <button
                      type="button"
                      className={`date-option ${isSelected ? 'is-selected' : ''}`.trim()}
                      key={option.key}
                      aria-pressed={isSelected}
                      aria-controls="program-by-date"
                      aria-label={`Mostrar sessões de ${formatSessionDay(option.startsAt)}`}
                      onClick={() => setSelectedDateKey(option.key)}
                    >
                      <span>{labels.weekday}</span>
                      <strong>{labels.day}</strong>
                      <small>{labels.month}</small>
                    </button>
                  )
                })}
              </div>

              <div id="program-by-date">
                <div
                  className="selected-program-date"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <h3>{selectedDate ? formatSessionDay(selectedDate.startsAt) : ''}</h3>
                  <span>
                    {selectedSessions.length}{' '}
                    {selectedSessions.length === 1 ? 'sessão' : 'sessões'}
                  </span>
                </div>

                {moviePrograms.length === 0 ? (
                  <div className="content-state public-state empty-state">
                    <h3>Nenhuma sessão nesta data.</h3>
                    <p>Escolha outro dia disponível acima.</p>
                  </div>
                ) : (
                  <div className="movie-program-list">
                    {moviePrograms.map((program) => (
                      <article className="movie-program" key={program.key}>
                        <header className="movie-program-heading">
                          <div>
                            <h3>{program.movie.title}</h3>
                            {program.movie.releaseDate ? (
                              <p>{movieYear(program.movie.releaseDate)}</p>
                            ) : null}
                          </div>
                          <p className="movie-program-price">
                            <span>
                              {program.hasDifferentPrices
                                ? 'A partir de'
                                : 'Ingresso'}
                            </span>
                            <strong>{formatPrice(program.minimumPriceCents)}</strong>
                          </p>
                        </header>

                        <div className="venue-program-list">
                          {program.venues.map((venue) => (
                            <section
                              className="venue-program"
                              key={venue.key}
                              aria-label={`${venue.venueName}, ${venue.roomName}`}
                            >
                              <div className="venue-program-heading">
                                <strong>{venue.venueName}</strong>
                                <span>{venue.roomName}</span>
                              </div>
                              <div className="showtime-list">
                                {venue.sessions.map((session) => (
                                  <button
                                    type="button"
                                    className="showtime-button"
                                    key={session.id}
                                    onClick={() => onOpenSession(session.id)}
                                    aria-label={`Sessão de ${program.movie.title} em ${formatSessionDay(session.startsAt)}, às ${formatSessionTime(session.startsAt)}, ${venue.venueName}, ${venue.roomName}, ingresso ${formatPrice(session.priceCents)}`}
                                  >
                                    <time dateTime={session.startsAt}>
                                      {formatSessionTime(session.startsAt)}
                                    </time>
                                  </button>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}
