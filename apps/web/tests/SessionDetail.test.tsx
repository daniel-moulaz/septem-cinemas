import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicSessionDetail, SessionSeat } from '../src/api'
import axe from 'axe-core'

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  getPublicSession: vi.fn(),
  getSessionSeats: vi.fn(),
  createReservation: vi.fn(),
  sessionEventsUrl: (id: string) => `http://localhost/sessions/${id}/events`,
}))

const { getPublicSession, getSessionSeats } = await import('../src/api')
const { SessionDetail } = await import(
  '../src/components/public/SessionDetail'
)
const { ToastProvider } = await import('../src/components/common/ToastProvider')

const session: PublicSessionDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  startsAt: '2026-08-24T22:40:00.000Z',
  venueName: 'SEPTEM Paulista',
  roomName: 'Sala Marfim',
  address: 'Avenida Paulista, 1000',
  priceCents: 2_600,
  capacity: 3,
  movie: {
    tmdbId: 603,
    title: 'Matrix',
    overview: 'Sinopse.',
    posterPath: null,
    backdropPath: null,
    releaseDate: '1999-03-31',
    runtimeMinutes: 136,
  },
}

// Um assento de cada estado: livre, vendido e em hold de outro cliente.
const seats: SessionSeat[] = [
  { id: 'seat-a1', label: 'A1', rowLabel: 'A', number: 1, status: 'AVAILABLE' },
  { id: 'seat-a2', label: 'A2', rowLabel: 'A', number: 2, status: 'SOLD' },
  { id: 'seat-a3', label: 'A3', rowLabel: 'A', number: 3, status: 'HELD' },
]

function renderSessionDetail() {
  return render(
    <ToastProvider>
      <SessionDetail
        sessionId={session.id}
        user={undefined}
        accessToken={undefined}
        onBack={() => undefined}
        onRequireLogin={() => undefined}
        onReservationCreated={() => undefined}
      />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.mocked(getPublicSession).mockResolvedValue(session)
  vi.mocked(getSessionSeats).mockResolvedValue(seats)
})

describe('mapa de assentos', () => {
  it('permite seleção por teclado e não tem violações automáticas de acessibilidade', async () => {
    const user = userEvent.setup()
    const { container } = renderSessionDetail()
    const seat = await screen.findByRole('button', { name: 'Assento A1, disponível' })
    seat.focus()
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Assento A1, selecionado' })).toHaveFocus()
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([])
  })
  it('descreve cada estado no nome acessível, e não apenas na cor', async () => {
    renderSessionDetail()

    // Quem usa leitor de tela precisa distinguir os três estados sem enxergar
    // a cor do botão.
    expect(
      await screen.findByRole('button', { name: 'Assento A1, disponível' }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Assento A2, vendido' }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Assento A3, indisponível' }),
    ).toBeVisible()
  })

  it('não deixa selecionar assento vendido nem em hold de outro cliente', async () => {
    const user = userEvent.setup()
    renderSessionDetail()

    const sold = await screen.findByRole('button', {
      name: 'Assento A2, vendido',
    })
    const held = screen.getByRole('button', { name: 'Assento A3, indisponível' })
    expect(sold).toBeDisabled()
    expect(held).toBeDisabled()

    await user.click(sold)
    await user.click(held)

    // Nenhum dos dois entra na seleção.
    expect(
      screen.queryByRole('button', { name: 'Assento A2, selecionado' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Assento A3, selecionado' }),
    ).not.toBeInTheDocument()
  })

  it('marca o assento livre como selecionado ao clicar e reflete no total', async () => {
    const user = userEvent.setup()
    renderSessionDetail()

    const available = await screen.findByRole('button', {
      name: 'Assento A1, disponível',
    })
    expect(available).toHaveAttribute('aria-pressed', 'false')

    await user.click(available)

    const selected = await screen.findByRole('button', {
      name: 'Assento A1, selecionado',
    })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    // O preço confirmado pelo servidor aparece no resumo da seleção.
    expect(screen.getAllByText('R$ 26,00').length).toBeGreaterThan(0)
  })
})
