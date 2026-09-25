import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { App } from '../src/App'
import { ToastProvider } from '../src/components/common/ToastProvider'
import { ApiError, getCurrentUser, login } from '../src/api'

vi.mock('../src/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/api')>(),
  login: vi.fn(), getCurrentUser: vi.fn(),
}))
vi.mock('../src/components/public/PublicCatalog', () => ({
  PublicCatalog: () => <h1>Programação de teste</h1>,
}))
const customer = { id: 'customer', name: 'Cliente', email: 'customer1@demo.local', role: 'CUSTOMER' as const }
beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState({}, '', '/login')
  window.scrollTo = vi.fn()
  vi.mocked(login).mockReset().mockResolvedValue({ accessToken: 'token', user: customer })
  vi.mocked(getCurrentUser).mockReset()
})
function view() { return render(<ToastProvider><App /></ToastProvider>) }
async function enter(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('E-mail'), customer.email)
  await user.type(screen.getByLabelText('Senha'), 'Demo@123')
  await user.click(screen.getByRole('button', { name: 'Entrar' }))
}

it('supports login, logout and a second login without retaining the old session', async () => {
  const user = userEvent.setup()
  view()
  await enter(user)
  expect(await screen.findByRole('heading', { name: 'Programação de teste' })).toBeVisible()
  expect(sessionStorage.getItem('septem-access-token')).toBe('token')
  await user.click(screen.getByRole('button', { name: 'Sair' }))
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  await user.click(screen.getByRole('link', { name: 'Entrar' }))
  await enter(user)
  expect(login).toHaveBeenCalledTimes(2)
})

it('keeps invalid-credentials feedback accessible and allows correction', async () => {
  vi.mocked(login).mockRejectedValueOnce(new ApiError('E-mail ou senha inválidos.', 401))
  const user = userEvent.setup()
  const { container } = view()
  await enter(user)
  expect(await screen.findByText('E-mail ou senha inválidos.')).toHaveAttribute('role', 'alert')
  expect(screen.getByLabelText('Senha')).toHaveAttribute('aria-invalid', 'true')
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([])
  await user.type(screen.getByLabelText('Senha'), 'x')
  expect(screen.getByLabelText('Senha')).toHaveAttribute('aria-invalid', 'false')
})

it('handles storage denial without blocking login or logout', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
  const user = userEvent.setup()
  view()
  await enter(user)
  await user.click(await screen.findByRole('button', { name: 'Sair' }))
  expect(screen.getByRole('link', { name: 'Entrar' })).toBeVisible()
})

it('clears an expired restored token and presents the login form', async () => {
  sessionStorage.setItem('septem-access-token', 'expired')
  vi.mocked(getCurrentUser).mockRejectedValue(new ApiError('Expired', 401))
  view()
  await waitFor(() => expect(screen.getByLabelText('E-mail')).toBeVisible())
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(screen.getByText(/Sua sessão expirou/)).toBeVisible()
})
