import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  getCatalogMovie,
  getCatalogMovies,
  type CatalogMovie,
} from '../../api'
import { tmdbPosterUrl } from './formatters'
import { PosterImage } from '../common/PosterImage'

interface MoviePickerProps {
  accessToken: string
  disabled: boolean
  selectedMovie: CatalogMovie | null
  onSelect: (movie: CatalogMovie) => void
  onSelectionBusyChange: (isBusy: boolean) => void
}

interface CatalogRequest {
  query: string
  revision: number
}

const catalogSkeletonItems = Array.from({ length: 6 }, (_, index) => index)

function movieDescription(movie: CatalogMovie): string | null {
  const details: string[] = []

  if (movie.releaseDate) {
    details.push(movie.releaseDate.slice(0, 4))
  }

  if (movie.runtimeMinutes) {
    details.push(`${movie.runtimeMinutes} min`)
  }

  return details.length > 0 ? details.join(' · ') : null
}

export function MoviePicker({
  accessToken,
  disabled,
  selectedMovie,
  onSelect,
  onSelectionBusyChange,
}: MoviePickerProps) {
  const selectionControllerRef = useRef<AbortController | null>(null)
  const [isChoosing, setIsChoosing] = useState(selectedMovie === null)
  const [query, setQuery] = useState('')
  const [request, setRequest] = useState<CatalogRequest>({
    query: '',
    revision: 0,
  })
  const [movies, setMovies] = useState<CatalogMovie[]>([])
  const [isLoading, setIsLoading] = useState(selectedMovie === null)
  const [selectingId, setSelectingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () => () => {
      selectionControllerRef.current?.abort()
      onSelectionBusyChange(false)
    },
    [onSelectionBusyChange],
  )

  useEffect(() => {
    if (!isChoosing) {
      return
    }

    const controller = new AbortController()

    getCatalogMovies(accessToken, request.query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        setMovies(response.movies)
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setMovies([])
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Não foi possível consultar o catálogo agora.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      })

    return () => controller.abort()
  }, [accessToken, isChoosing, request.query, request.revision])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsLoading(true)
    setError(null)
    setRequest((current) => ({
      query: query.trim(),
      revision: current.revision + 1,
    }))
  }

  async function handleSelect(movie: CatalogMovie) {
    selectionControllerRef.current?.abort()
    const controller = new AbortController()
    selectionControllerRef.current = controller
    onSelectionBusyChange(true)
    setSelectingId(movie.id)
    setError(null)

    try {
      const details = await getCatalogMovie(
        accessToken,
        movie.id,
        controller.signal,
      )

      if (controller.signal.aborted) {
        return
      }

      onSelect(details)
      setIsChoosing(false)
    } catch (selectionError) {
      if (controller.signal.aborted) {
        return
      }

      setError(
        selectionError instanceof ApiError
          ? selectionError.message
          : 'Não foi possível carregar os detalhes desse filme.',
      )
    } finally {
      if (selectionControllerRef.current === controller) {
        selectionControllerRef.current = null
        setSelectingId(null)
        onSelectionBusyChange(false)
      }
    }
  }

  if (selectedMovie && !isChoosing) {
    const posterUrl = tmdbPosterUrl(selectedMovie.posterPath)
    const description = movieDescription(selectedMovie)

    return (
      <section
        className="selected-movie"
        aria-busy={disabled}
        aria-labelledby="selected-movie-title"
      >
        <PosterImage
          src={posterUrl}
          title={selectedMovie.title}
          className="selected-movie-poster"
        />
        <div>
          <p className="section-kicker">Filme selecionado</p>
          <h2 id="selected-movie-title">{selectedMovie.title}</h2>
          {description ? <p>{description}</p> : null}
          <button
            type="button"
            className="text-button"
            disabled={disabled || selectingId !== null}
            onClick={() => {
              setIsLoading(true)
              setError(null)
              setIsChoosing(true)
            }}
          >
            Escolher outro filme
          </button>
        </div>
      </section>
    )
  }

  const resultTitle = request.query
    ? `Resultados para “${request.query}”`
    : 'Filmes em cartaz'

  return (
    <section
      className="movie-picker"
      aria-busy={disabled || isLoading || selectingId !== null}
      aria-labelledby="movie-picker-title"
    >
      <div className="section-heading">
        <div>
          <p className="section-kicker">Passo 1</p>
          <h2 id="movie-picker-title">Escolha o filme</h2>
        </div>
        {selectedMovie ? (
          <button
            type="button"
            className="text-button"
            disabled={disabled || selectingId !== null}
            onClick={() => setIsChoosing(false)}
          >
            Manter seleção atual
          </button>
        ) : null}
      </div>

      <form className="movie-search" role="search" onSubmit={handleSearch}>
        <div className="field">
          <label htmlFor="movie-query">Título do filme</label>
          <input
            id="movie-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ex.: Interestelar"
            disabled={disabled || isLoading || selectingId !== null}
          />
        </div>
        <button
          type="submit"
          disabled={disabled || isLoading || selectingId !== null}
        >
          {isLoading ? 'Buscando…' : 'Buscar'}
        </button>
        {request.query ? (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || isLoading || selectingId !== null}
            onClick={() => {
              setQuery('')
              setIsLoading(true)
              setError(null)
              setRequest((current) => ({
                query: '',
                revision: current.revision + 1,
              }))
            }}
          >
            Ver em cartaz
          </button>
        ) : null}
      </form>

      {error ? (
        <div className="inline-state error-message" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="text-button"
            disabled={disabled || selectingId !== null}
            onClick={() => {
              setIsLoading(true)
              setError(null)
              setRequest((current) => ({
                ...current,
                revision: current.revision + 1,
              }))
            }}
          >
            Tentar novamente
          </button>
        </div>
      ) : null}

      <div className="catalog-heading">
        <h3>{resultTitle}</h3>
        {!isLoading ? <span>{movies.length} encontrados</span> : null}
      </div>

      {isLoading ? (
        <div className="movie-picker-loading" role="status">
          <span className="visually-hidden">Carregando catálogo…</span>
          <div
            className="movie-grid movie-grid-skeleton"
            aria-hidden="true"
          >
            {catalogSkeletonItems.map((item) => (
              <article className="movie-card movie-card-skeleton" key={item}>
                <span className="movie-card-poster skeleton-block" />
                <div className="movie-card-content">
                  <span className="movie-skeleton-title skeleton-block" />
                  <span className="movie-skeleton-meta skeleton-block" />
                  <span className="movie-skeleton-action skeleton-block" />
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : movies.length === 0 && !error ? (
        <p className="inline-state">
          Nenhum filme encontrado. Tente outro título.
        </p>
      ) : (
        <div className="movie-grid">
          {movies.map((movie) => {
            const posterUrl = tmdbPosterUrl(movie.posterPath)
            const isSelecting = selectingId === movie.id
            const releaseYear = movie.releaseDate?.slice(0, 4)

            return (
              <article className="movie-card" key={movie.id}>
                <PosterImage
                  src={posterUrl}
                  title={movie.title}
                  className="movie-card-poster"
                  loading="lazy"
                />
                <div className="movie-card-content">
                  <h4>{movie.title}</h4>
                  {releaseYear ? <p>{releaseYear}</p> : null}
                  <button
                    type="button"
                    onClick={() => void handleSelect(movie)}
                    disabled={disabled || selectingId !== null}
                    aria-label={`Selecionar ${movie.title}`}
                  >
                    {isSelecting ? 'Carregando…' : 'Selecionar'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
