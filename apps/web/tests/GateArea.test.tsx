import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedUser, GateConsumeResult } from '../src/api'

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  getGateSessions: vi.fn(),
  consumeGateTicket: vi.fn(),
}))

// Isola câmera e @zxing/browser: o scanner real depende de getUserMedia, que o
// jsdom não implementa. O dublê expõe o estado `active` como texto, que é
// justamente o comportamento que a portaria precisa garantir.
vi.mock('../src/components/gate/QrScanner', () => ({
  QrScanner: ({
    active,
    pausedMessage,
  }: {
    active: boolean
    pausedMessage: string
  }) => (
    <div data-testid="qr-scanner">
      {active ? 'scanner ativo' : `scanner parado: ${pausedMessage}`}
    </div>
  ),
}))

const { getGateSessions, consumeGateTicket } = await import('../src/api')
const { GateArea } = await import('../src/components/gate/GateArea')

const session = {
  id: '11111111-1111-4111-8111-111111111111',
  startsAt: '2026-08-24T22:40:00.000Z',
  venueName: 'SEPTEM Paulista',
  roomName: 'Sala Marfim',
  movie: { title: 'Matrix', posterPath: null },
}

const gateUser: AuthenticatedUser = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Portaria Demo',
  email: 'gate@demo.local',
  role: 'GATE',
}

function renderGate() {
  return render(
    <GateArea accessToken="token" user={gateUser} onLogout={() => undefined} />,
  )
}

/** A portaria só mostra o formulário depois que uma sessão é escolhida. */
async function selectSession(user: ReturnType<typeof userEvent.setup>) {
  const card = await screen.findByRole('button', { name: /Matrix/ })
  await user.click(card)

  return screen.getByLabelText('Código do ingresso')
}

beforeEach(() => {
  vi.mocked(getGateSessions).mockResolvedValue([session])
  vi.mocked(consumeGateTicket).mockReset()
})

describe('portaria', () => {
  it('não chama a API quando o código está vazio ou só com espaços', async () => {
    const user = userEvent.setup()
    renderGate()
    const input = await selectSession(user)

    const submit = screen.getByRole('button', { name: 'Validar ingresso' })
    expect(submit).toBeDisabled()

    await user.type(input, '   ')

    expect(submit).toBeDisabled()
    expect(consumeGateTicket).not.toHaveBeenCalled()
  })

  it('envia o código em maiúsculas e sem espaços nas pontas', async () => {
    const user = userEvent.setup()
    vi.mocked(consumeGateTicket).mockResolvedValue({ result: 'INVALID' })
    renderGate()
    const input = await selectSession(user)

    // A normalização de hífen e espaço entre grupos é responsabilidade do
    // backend (`normalizeManualCode`); ao frontend cabe não corromper o que
    // o operador digitou.
    await user.type(input, ' gyeb-2k7m-4npq-9rst ')
    expect(input).toHaveValue(' GYEB-2K7M-4NPQ-9RST ')

    await user.click(screen.getByRole('button', { name: 'Validar ingresso' }))

    await waitFor(() => {
      expect(consumeGateTicket).toHaveBeenCalledWith(
        'token',
        session.id,
        'GYEB-2K7M-4NPQ-9RST',
      )
    })
  })

  it.each([
    ['VALID', 'INGRESSO VÁLIDO'],
    ['INVALID', 'INGRESSO INVÁLIDO'],
    ['ALREADY_USED', 'INGRESSO JÁ UTILIZADO'],
    ['WRONG_EVENT', 'OUTRA SESSÃO'],
  ] as const)('anuncia %s com um título inequívoco', async (result, title) => {
    const payload = {
      VALID: {
        result: 'VALID',
        usedAt: '2026-08-24T22:45:00.000Z',
        ticket: {
          seat: { label: 'A1' },
          session: { ...session, movie: { title: 'Matrix' } },
        },
      },
      INVALID: { result: 'INVALID' },
      ALREADY_USED: { result: 'ALREADY_USED', usedAt: null },
      WRONG_EVENT: { result: 'WRONG_EVENT' },
    }[result] as GateConsumeResult

    const user = userEvent.setup()
    vi.mocked(consumeGateTicket).mockResolvedValue(payload)
    renderGate()
    const input = await selectSession(user)

    await user.type(input, 'GYEB2K7M4NPQ9RST')
    await user.click(screen.getByRole('button', { name: 'Validar ingresso' }))

    // Cada resultado tem um título próprio, e não uma variação de cor.
    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
  })

  it('mantém o scanner parado enquanto a validação não responde', async () => {
    const user = userEvent.setup()
    let resolveConsume: (value: GateConsumeResult) => void = () => undefined
    vi.mocked(consumeGateTicket).mockReturnValue(
      new Promise<GateConsumeResult>((resolve) => {
        resolveConsume = resolve
      }),
    )

    renderGate()
    const input = await selectSession(user)
    expect(screen.getByTestId('qr-scanner')).toHaveTextContent('scanner ativo')

    await user.type(input, 'GYEB2K7M4NPQ9RST')
    await user.click(screen.getByRole('button', { name: 'Validar ingresso' }))

    // Enquanto a resposta não chega, a câmera não pode ler outro ingresso.
    await waitFor(() => {
      expect(screen.getByTestId('qr-scanner')).toHaveTextContent(
        'scanner parado: Validação em andamento…',
      )
    })

    resolveConsume({ result: 'INVALID' })
    expect(await screen.findByRole('heading', { name: 'INGRESSO INVÁLIDO' })).toBeVisible()
  })
})
