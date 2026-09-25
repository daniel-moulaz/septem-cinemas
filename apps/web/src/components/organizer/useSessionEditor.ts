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
  type SessionInput,
  type SessionUpdateInput,
} from '../../api'
import { useToast } from '../common/toast'
import { useSessionForm, type SessionFormState } from './useSessionForm'

export interface SessionEditorProps {
  accessToken: string
  sessionId?: string
  onBack: () => void
  onCreated?: (sessionId: string) => void
  onDirtyChange: (isDirty: boolean) => void
  onBusyChange: (isBusy: boolean) => void
}

/**
 * Operação em curso no editor. Salvar, publicar e escolher filme não podem
 * acontecer ao mesmo tempo — cada uma desabilita os controles das outras —,
 * então convivem em um único estado em vez de três booleanos independentes.
 * Duplicar não entra aqui: ela sai do editor em vez de operar sobre ele.
 */
type EditorAction = 'idle' | 'saving' | 'publishing' | 'selecting-movie'

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

export function useSessionEditor({
  accessToken,
  sessionId,
  onCreated,
  onDirtyChange,
  onBusyChange,
}: SessionEditorProps) {
  const { notify } = useToast()
  const [session, setSession] = useState<OrganizerSession | null>(null)
  const [selectedMovie, setSelectedMovie] = useState<CatalogMovie | null>(null)
  const {
    form,
    fieldErrors,
    isDirty,
    setFieldValue,
    clearFieldError,
    setFieldErrors,
    markDirty,
    resetFrom,
    validate,
  } = useSessionForm(onDirtyChange)
  const [isLoading, setIsLoading] = useState(Boolean(sessionId))
  // Salvar, publicar e escolher filme são mutuamente exclusivos por
  // construção: cada um desabilita os controles dos outros enquanto corre.
  // Um único estado discriminado torna isso explícito e impede a combinação
  // impossível de dois deles ativos ao mesmo tempo.
  const [action, setAction] = useState<EditorAction>('idle')
  // Duplicar cria outro rascunho; também bloqueia a navegação enquanto aguarda.
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false)
  const publishDialogRef = useRef<HTMLDialogElement>(null)

  const isSaving = action === 'saving'
  const isPublishing = action === 'publishing'
  const isBusy = action !== 'idle' || isDuplicating

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
        if (controller.signal.aborted) return
        setSession(loadedSession)
        setSelectedMovie(movieFromSession(loadedSession))
        resetFrom(loadedSession)
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
    // `resetFrom` é estável: deriva de `onDirtyChange`, que o pai passa como
    // setter de estado. Entra aqui no lugar de `onDirtyChange`, que o efeito
    // deixou de chamar diretamente.
  }, [accessToken, loadRevision, resetFrom, sessionId])

  const isPublishedSession = session?.status === 'PUBLISHED'

  // Events invalidate the snapshot; the form remains the user's draft.
  // Pausing during mutations prevents an older read overwriting their result.
  useEffect(() => {
    if (!sessionId || !isPublishedSession || isBusy) return
    const controller = new AbortController()
    const source = typeof EventSource === 'undefined'
      ? null : new EventSource(sessionEventsUrl(sessionId))
    let inFlight = false
    let pending = false

    async function refreshSnapshot() {
      if (controller.signal.aborted || document.hidden) return
      if (inFlight) { pending = true; return }
      inFlight = true
      try {
        let remaining = 8
        do {
          pending = false
          const loaded = await getOrganizerSession(accessToken, sessionId!, controller.signal)
          if (controller.signal.aborted) return
          setSession(loaded)
          remaining -= 1
        } while (pending && remaining > 0)
      } catch {
        // Keep the last snapshot; polling/reconnection can recover.
      } finally { inFlight = false }
    }
    const refresh = () => { void refreshSnapshot() }
    const events = ['sync', 'seats-changed', 'session-changed']
    for (const event of events) source?.addEventListener(event, refresh)
    const polling = setInterval(refresh, 8_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort()
      clearInterval(polling)
      document.removeEventListener('visibilitychange', refresh)
      for (const event of events) source?.removeEventListener(event, refresh)
      source?.close()
    }
  }, [accessToken, isPublishedSession, sessionId, isBusy])

  function updateField(field: keyof SessionFormState, value: string) {
    setFieldValue(field, value)
    setNotice(null)
    setActionError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setActionError(null)
    setNotice(null)

    const validation = validate(selectedMovie)
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
          markDirty(false)
          setNotice('A sessão já está atualizada.')
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
      resetFrom(savedSession)

      const successMessage = isNewSession
        ? 'Rascunho criado com sucesso. Agora você pode publicá-lo.'
        : 'Sessão atualizada com sucesso.'

      notify(successMessage, 'success')

      if (isNewSession) {
        onCreated?.(savedSession.id)
      }
    } catch (saveError) {
      setActionError(
        saveError instanceof ApiError
          ? saveError.message
          : 'Não foi possível salvar a sessão.',
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
      markDirty(false)
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

  return {
    session,
    selectedMovie,
    setSelectedMovie,
    form,
    fieldErrors,
    isDirty,
    clearFieldError,
    markDirty,
    isLoading,
    isBusy,
    isSaving,
    isPublishing,
    isDuplicating,
    loadError,
    actionError,
    notice,
    setActionError,
    setNotice,
    setIsLoading,
    setLoadError,
    setLoadRevision,
    isPublishDialogOpen,
    setIsPublishDialogOpen,
    publishDialogRef,
    setSelectingMovie,
    updateField,
    handleSubmit,
    duplicateThisSession,
    handlePublish,
  }
}
