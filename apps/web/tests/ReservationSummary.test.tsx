import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Reservation } from '../src/api'

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  getReservation: vi.fn(),
  payReservation: vi.fn(),
}))

const { getReservation, payReservation } = await import('../src/api')
const { ReservationSummary } = await import(
  '../src/components/public/ReservationSummary'
)

const reservation: Reservation = {
  id: '33333333-3333-4333-8333-333333333333',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  totalCents: 2_600,
  session: {
    id: '11111111-1111-4111-8111-111111111111',
    startsAt: '2026-08-24T22:40:00.000Z',
    venueName: 'SEPTEM Paulista',
    roomName: 'Sala Marfim',
    movie: { title: 'Matrix', posterPath: null },
  },
  seats: [{ id: 'seat-a1', label: 'A1', unitPriceCents: 2_600 }],
}

function renderCheckout(overrides: Partial<Parameters<typeof ReservationSummary>[0]> = {}) {
  return render(
    <ReservationSummary
      reservationId={reservation.id}
      accessToken="token"
      initialReservation={reservation}
      onBackToSession={() => undefined}
      onBackToCatalog={() => undefined}
      onOpenTicket={() => undefined}
      onOpenTickets={() => undefined}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.mocked(getReservation).mockResolvedValue(reservation)
  vi.mocked(payReservation).mockReset()
})

describe('checkout simulado', () => {
  it('mostra recusa compreensível e não oferece ingresso', async () => {
    const user = userEvent.setup()
    const onOpenTicket = vi.fn()
    vi.mocked(payReservation).mockResolvedValue({
      payment: {
        id: 'pay-1',
        status: 'DECLINED',
        amountCents: 2_600,
        createdAt: new Date().toISOString(),
      },
      reservation: { id: reservation.id, status: 'CANCELLED' },
      tickets: [],
    })

    renderCheckout({ onOpenTicket })

    await user.click(
      await screen.findByRole('button', { name: 'Recusar pagamento' }),
    )

    expect(await screen.findByText('Pagamento recusado')).toBeVisible()
    expect(
      screen.getByText(/Nenhum ingresso foi emitido e os lugares foram liberados/),
    ).toBeVisible()

    // Nenhum caminho para ingresso é oferecido depois de uma recusa.
    expect(
      screen.queryByRole('button', { name: 'Ver meu ingresso' }),
    ).not.toBeInTheDocument()
    expect(onOpenTicket).not.toHaveBeenCalled()
  })

  it('leva ao ingresso emitido quando o pagamento é aprovado', async () => {
    const user = userEvent.setup()
    const onOpenTicket = vi.fn()
    vi.mocked(payReservation).mockResolvedValue({
      payment: {
        id: 'pay-2',
        status: 'APPROVED',
        amountCents: 2_600,
        createdAt: new Date().toISOString(),
      },
      reservation: { id: reservation.id, status: 'PAID' },
      tickets: [{ id: 'ticket-1' }],
    })

    renderCheckout({ onOpenTicket })

    await user.click(
      await screen.findByRole('button', { name: 'Aprovar pagamento' }),
    )

    expect(await screen.findByText('Pagamento aprovado')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Ver meu ingresso' }))

    await waitFor(() => {
      expect(onOpenTicket).toHaveBeenCalledWith('ticket-1')
    })
  })
})
