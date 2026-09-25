import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import type { OrganizerSession } from '../src/api'

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  getOrganizerSession: vi.fn(),
  updateOrganizerSession: vi.fn(),
  publishOrganizerSession: vi.fn(),
  duplicateOrganizerSession: vi.fn(),
  createOrganizerSession: vi.fn(),
  getCatalogMovie: vi.fn(),
  getCatalogMovies: vi.fn().mockResolvedValue([]),
  sessionEventsUrl: (id: string) => `http://localhost/sessions/${id}/events`,
}))

const { getOrganizerSession, updateOrganizerSession, publishOrganizerSession, duplicateOrganizerSession } = await import('../src/api')
const { SessionEditor } = await import(
  '../src/components/organizer/SessionEditor'
)
const { ToastProvider } = await import('../src/components/common/ToastProvider')
vi.mock('../src/components/organizer/SessionList', () => ({
  SessionList: ({ onOpen }: { onOpen: (id: string) => void }) =>
    <button onClick={() => onOpen('11111111-1111-4111-8111-111111111111')}>Abrir sessão</button>,
}))
const { OrganizerArea } = await import('../src/components/organizer/OrganizerArea')

const baseSession: OrganizerSession = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'PUBLISHED',
  startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  venueName: 'SEPTEM Paulista',
  roomName: 'Sala Marfim',
  address: 'Avenida Paulista, 1000',
  priceCents: 2_600,
  publishedAt: '2026-08-20T10:00:00.000Z',
  capacity: 32,
  rows: 4,
  seatsPerRow: 8,
  movie: {
    tmdbId: 603,
    title: 'Matrix',
    overview: 'Sinopse.',
    posterPath: null,
    backdropPath: null,
    releaseDate: '1999-03-31',
    runtimeMinutes: 136,
  },
  editability: { allowed: true, reason: 'PUBLISHED_SAFE', layoutEditable: true },
  metrics: {
    capacity: 32,
    availableSeats: 32,
    heldSeats: 0,
    soldSeats: 0,
    occupancyPercentage: 0,
    simulatedRevenueCents: 0,
  },
}

function renderEditor(
  overrides: Partial<Parameters<typeof SessionEditor>[0]> = {},
) {
  return render(
    <ToastProvider>
      <SessionEditor
        accessToken="token"
        sessionId={baseSession.id}
        onBack={() => undefined}
        onDirtyChange={() => undefined}
        onBusyChange={() => undefined}
        {...overrides}
      />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.mocked(getOrganizerSession).mockReset()
  vi.mocked(publishOrganizerSession).mockReset()
  vi.mocked(duplicateOrganizerSession).mockReset()
  vi.mocked(getOrganizerSession).mockResolvedValue(baseSession)
  vi.mocked(updateOrganizerSession).mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('editor de sessão do organizador', () => {
  it('navega para a cópia ao duplicar pela área do organizador', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const copy = { ...baseSession, id: '22222222-2222-4222-8222-222222222222', status: 'DRAFT' as const }
    vi.mocked(duplicateOrganizerSession).mockResolvedValue(copy)
    vi.mocked(getOrganizerSession).mockImplementation(async (_token, id) => id === copy.id ? copy : baseSession)
    const user = userEvent.setup()
    render(<ToastProvider><OrganizerArea accessToken="token" user={{ id: 'organizer', role: 'ORGANIZER', name: 'Organizador', email: 'organizer@demo.local' }} onLogout={vi.fn()} /></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Abrir sessão' }))
    await user.click(await screen.findByRole('button', { name: 'Duplicar sessão' }))
    await waitFor(() => expect(getOrganizerSession).toHaveBeenCalledWith('token', copy.id, expect.any(AbortSignal)))
    expect(await screen.findByRole('button', { name: 'Publicar sessão' })).toBeVisible()
  })
  it('reconsulta eventos recebidos durante um fetch e preserva o formulário', async () => {
    class Stream extends EventTarget {
      static current: Stream
      close = vi.fn()
      constructor() { super(); Stream.current = this }
    }
    vi.stubGlobal('EventSource', Stream)
    const user = userEvent.setup()
    const view = renderEditor()
    await user.type(await screen.findByLabelText('Sala'), ' editando')
    let resolveRead!: (value: OrganizerSession) => void
    vi.mocked(getOrganizerSession).mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve }))
    vi.mocked(getOrganizerSession).mockResolvedValueOnce({ ...baseSession, roomName: 'remota mais nova' })
    act(() => Stream.current.dispatchEvent(new Event('seats-changed')))
    const signal = vi.mocked(getOrganizerSession).mock.calls.at(-1)![2]!
    act(() => Stream.current.dispatchEvent(new Event('session-changed')))
    await act(async () => resolveRead({ ...baseSession, roomName: 'remota antiga' }))
    expect(getOrganizerSession).toHaveBeenCalledTimes(3)
    expect(screen.getByLabelText('Sala')).toHaveValue('Sala Marfim editando')
    view.unmount()
    expect(signal.aborted).toBe(true)
    expect(Stream.current.close).toHaveBeenCalledOnce()
  })

  it('atualiza por polling quando EventSource não existe', async () => {
    vi.useFakeTimers()
    renderEditor()
    await act(() => vi.advanceTimersByTimeAsync(0))
    vi.mocked(getOrganizerSession).mockClear()
    await act(() => vi.advanceTimersByTimeAsync(8_000))
    expect(getOrganizerSession).toHaveBeenCalledOnce()
  })

  it('não apresenta publicação em uma sessão já publicada e tem formulário acessível', async () => {
    const { container } = renderEditor()
    await screen.findByLabelText('Sala')
    expect(screen.queryByRole('button', { name: 'Publicar sessão' })).not.toBeInTheDocument()
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([])
  })
  it('recupera erro de carregamento por tentativa manual', async () => {
    vi.mocked(getOrganizerSession).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByLabelText('Sala')).toHaveValue(baseSession.roomName)
  })

  it('preserva alterações e dirty state quando salvar falha', async () => {
    vi.mocked(updateOrganizerSession).mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderEditor()
    await user.type(await screen.findByLabelText('Sala'), ' nova')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar')
    expect(screen.getByLabelText('Sala')).toHaveValue('Sala Marfim nova')
    expect(screen.getByText('Alterações não salvas')).toBeVisible()
  })

  it('publica somente depois da confirmação explícita', async () => {
    vi.mocked(getOrganizerSession).mockResolvedValue({ ...baseSession, status: 'DRAFT', publishedAt: null })
    vi.mocked(publishOrganizerSession).mockResolvedValue(baseSession)
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('button', { name: 'Publicar sessão' }))
    expect(screen.getByRole('dialog', { name: 'Publicar esta sessão?' })).toBeVisible()
    expect(publishOrganizerSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirmar publicação' }))
    await waitFor(() => expect(publishOrganizerSession).toHaveBeenCalledWith('token', baseSession.id))
    expect(await screen.findByRole('heading', { name: 'Detalhes da sessão' })).toBeVisible()
  })

  it('abre a cópia retornada sem confundi-la com a sessão original', async () => {
    vi.mocked(duplicateOrganizerSession).mockResolvedValue({ ...baseSession, id: 'copy', status: 'DRAFT' })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    renderEditor({ onCreated })
    await user.click(await screen.findByRole('button', { name: 'Duplicar sessão' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('copy'))
    expect(duplicateOrganizerSession).toHaveBeenCalledWith('token', baseSession.id)
  })

  it('bloqueia só o layout quando existe histórico liberado', async () => {
    vi.mocked(getOrganizerSession).mockResolvedValue({ ...baseSession, editability: { ...baseSession.editability, layoutEditable: false } })
    renderEditor()
    expect(await screen.findByLabelText('Fileiras')).toBeDisabled()
    expect(screen.getByLabelText('Sala')).toBeEnabled()
    expect(screen.getByLabelText('Fileiras')).toHaveAccessibleDescription(/já foram reservados/)
  })
  it('explica o motivo real do bloqueio derivado pelo backend', async () => {
    vi.mocked(getOrganizerSession).mockResolvedValue({
      ...baseSession,
      editability: {
        allowed: false,
        reason: 'COMMERCIAL_HISTORY',
        layoutEditable: false,
      },
    })

    renderEditor()

    // Requisito de aceite 13: o organizador vê a causa concreta, e não uma
    // mensagem genérica de "bloqueado após publicação".
    expect(
      await screen.findByText(/possui reservas ou ingressos associados/i),
    ).toBeVisible()
    expect(
      screen.queryByText(/bloqueada após publicação/i),
    ).not.toBeInTheDocument()

    // Sem formulário de edição enquanto houver histórico comercial.
    expect(screen.queryByLabelText('Cinema ou local')).not.toBeInTheDocument()
  })

  it('permite editar e salvar uma sessão publicada sem histórico, mantendo-a publicada', async () => {
    const user = userEvent.setup()
    vi.mocked(updateOrganizerSession).mockResolvedValue({
      ...baseSession,
      roomName: 'Sala Rubi',
    })

    renderEditor()

    const room = await screen.findByLabelText('Sala')
    await user.clear(room)
    await user.type(room, 'Sala Rubi')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))

    await waitFor(() => {
      expect(updateOrganizerSession).toHaveBeenCalledWith(
        'token',
        baseSession.id,
        expect.objectContaining({ roomName: 'Sala Rubi' }),
      )
    })

    // Publicar deixou de congelar: a sessão continua PUBLISHED depois de salvar.
    expect(
      await screen.findByText(/Sessão publicada e ainda editável/i),
    ).toBeVisible()
  })

  it('avisa o guarda de saída assim que existe alteração não salva', async () => {
    const user = userEvent.setup()
    const onDirtyChange = vi.fn()

    renderEditor({ onDirtyChange })

    const room = await screen.findByLabelText('Sala')
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalledWith(false)
    })
    onDirtyChange.mockClear()

    await user.type(room, ' Reformada')
    expect(screen.getByRole('button', { name: 'Duplicar sessão' })).toBeDisabled()

    // É este aviso que faz OrganizerArea pedir confirmação antes de sair.
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalledWith(true)
    })
  })
})
