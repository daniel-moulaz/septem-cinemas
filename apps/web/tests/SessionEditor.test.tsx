import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const { getOrganizerSession, updateOrganizerSession } = await import('../src/api')
const { SessionEditor } = await import(
  '../src/components/organizer/SessionEditor'
)
const { ToastProvider } = await import('../src/components/common/ToastProvider')

const baseSession: OrganizerSession = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'PUBLISHED',
  startsAt: '2026-09-24T22:40:00.000Z',
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
  vi.mocked(getOrganizerSession).mockResolvedValue(baseSession)
  vi.mocked(updateOrganizerSession).mockReset()
})

describe('editor de sessão do organizador', () => {
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

    // É este aviso que faz OrganizerArea pedir confirmação antes de sair.
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalledWith(true)
    })
  })
})
