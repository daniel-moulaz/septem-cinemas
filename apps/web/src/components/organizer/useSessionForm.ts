import { useCallback, useState } from 'react'
import type {
  CatalogMovie,
  OrganizerSession,
  SessionInput,
} from '../../api'
import { toDateTimeLocalValue } from './formatters'

export interface SessionFormState {
  startsAt: string
  venueName: string
  roomName: string
  address: string
  price: string
  rows: string
  seatsPerRow: string
}

export type SessionFormField = keyof SessionFormState | 'movie'
export type SessionFormErrors = Partial<Record<SessionFormField, string>>

export interface SessionValidation {
  input: SessionInput | null
  errors: SessionFormErrors
}

const emptyForm: SessionFormState = {
  startsAt: '',
  venueName: '',
  roomName: '',
  address: '',
  price: '',
  rows: '6',
  seatsPerRow: '10',
}

export function formFromSession(session: OrganizerSession): SessionFormState {
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

/**
 * Validação pura do formulário. O servidor continua sendo a autoridade sobre
 * preço, horário e layout; isto existe para dar erro imediato no campo certo.
 */
export function validateForm(
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

export interface SessionFormController {
  form: SessionFormState
  fieldErrors: SessionFormErrors
  isDirty: boolean
  /** Escreve um campo, limpa o erro dele e marca o formulário como sujo. */
  setFieldValue: (field: keyof SessionFormState, value: string) => void
  /** Usado quando o filme muda: o valor não vive no form, o erro sim. */
  clearFieldError: (field: SessionFormField) => void
  setFieldErrors: (errors: SessionFormErrors) => void
  markDirty: (isDirty: boolean) => void
  /** Recarrega o formulário a partir do servidor e o considera limpo. */
  resetFrom: (session: OrganizerSession) => void
  validate: (movie: CatalogMovie | null) => SessionValidation
}

/**
 * Estado e validação do formulário de sessão.
 *
 * O `isDirty` é espelhado para fora por `onDirtyChange` porque quem decide
 * pedir confirmação antes de sair da tela é o componente pai, não o editor.
 */
export function useSessionForm(
  onDirtyChange: (isDirty: boolean) => void,
): SessionFormController {
  const [form, setForm] = useState<SessionFormState>(emptyForm)
  const [fieldErrors, setFieldErrors] = useState<SessionFormErrors>({})
  const [isDirty, setIsDirty] = useState(false)

  const markDirty = useCallback(
    (nextIsDirty: boolean) => {
      setIsDirty(nextIsDirty)
      onDirtyChange(nextIsDirty)
    },
    [onDirtyChange],
  )

  const clearFieldError = useCallback((field: SessionFormField) => {
    setFieldErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }, [])

  const setFieldValue = useCallback(
    (field: keyof SessionFormState, value: string) => {
      setForm((current) => ({ ...current, [field]: value }))
      clearFieldError(field)
      markDirty(true)
    },
    [clearFieldError, markDirty],
  )

  const resetFrom = useCallback(
    (session: OrganizerSession) => {
      setForm(formFromSession(session))
      markDirty(false)
    },
    [markDirty],
  )

  const validate = useCallback(
    (movie: CatalogMovie | null) => validateForm(form, movie),
    [form],
  )

  return {
    form,
    fieldErrors,
    isDirty,
    setFieldValue,
    clearFieldError,
    setFieldErrors,
    markDirty,
    resetFrom,
    validate,
  }
}
