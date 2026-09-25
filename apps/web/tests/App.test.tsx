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

it.each(['septem-access-token', 'elite-dev-access-token'])('clears an expired restored token from %s and presents the login form', async (key) => {
  sessionStorage.setItem(key, 'expired')
  vi.mocked(getCurrentUser).mockRejectedValue(new ApiError('Expired', 401))
  view()
  await waitFor(() => expect(screen.getByLabelText('E-mail')).toBeVisible())
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
  expect(screen.getByText(/Sua sessão expirou/)).toBeVisible()
})

it('prefers the current key and removes a divergent legacy token after validation', async () => {
  window.history.replaceState({}, '', '/')
  sessionStorage.setItem('septem-access-token', 'current')
  sessionStorage.setItem('elite-dev-access-token', 'different-user')
  vi.mocked(getCurrentUser).mockResolvedValue(customer)
  view()
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(getCurrentUser).toHaveBeenCalledExactlyOnceWith('current', expect.any(AbortSignal))
  expect(sessionStorage.getItem('septem-access-token')).toBe('current')
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})

it('validates a legacy token before migration, restores again using only the new key and clears both on logout', async () => {
  window.history.replaceState({}, '', '/')
  sessionStorage.setItem('elite-dev-access-token', 'legacy')
  let resolve!: (user: typeof customer) => void
  vi.mocked(getCurrentUser).mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const first = view()
  expect(getCurrentUser).toHaveBeenCalledWith('legacy', expect.any(AbortSignal))
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBe('legacy')
  resolve(customer)
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(sessionStorage.getItem('septem-access-token')).toBe('legacy')
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
  first.unmount()
  vi.mocked(getCurrentUser).mockClear().mockResolvedValue(customer)
  view()
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(getCurrentUser).toHaveBeenCalledExactlyOnceWith('legacy', expect.any(AbortSignal))
  // A stale tab/storage entry must not resurrect credentials after logout.
  sessionStorage.setItem('elite-dev-access-token', 'stale')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }))
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})

it('does not fall back to a different legacy identity when the current token is rejected', async () => {
  sessionStorage.setItem('septem-access-token', 'expired')
  sessionStorage.setItem('elite-dev-access-token', 'other-user')
  vi.mocked(getCurrentUser).mockRejectedValue(new ApiError('Expired', 401))
  view()
  expect(await screen.findByText(/Sua sessão expirou/)).toBeVisible()
  expect(getCurrentUser).toHaveBeenCalledExactlyOnceWith('expired', expect.any(AbortSignal))
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})

it('preserves the legacy token after a temporary restoration failure for a later recovery', async () => {
  sessionStorage.setItem('elite-dev-access-token', 'legacy')
  vi.mocked(getCurrentUser).mockRejectedValueOnce(new ApiError('Unavailable', 503))
  const first = view()
  expect(await screen.findByText(/Não foi possível restaurar sua sessão/)).toBeVisible()
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBe('legacy')
  first.unmount()
  vi.mocked(getCurrentUser).mockResolvedValue(customer)
  window.history.replaceState({}, '', '/')
  view()
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(sessionStorage.getItem('septem-access-token')).toBe('legacy')
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})

it('keeps the fallback and an authenticated in-memory session if writing the new key fails', async () => {
  window.history.replaceState({}, '', '/')
  sessionStorage.setItem('elite-dev-access-token', 'legacy')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  vi.mocked(getCurrentUser).mockResolvedValue(customer)
  view()
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBe('legacy')
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }))
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})

it('does not migrate credentials after the restoring component has unmounted', async () => {
  sessionStorage.setItem('elite-dev-access-token', 'legacy')
  let resolve!: (user: typeof customer) => void
  vi.mocked(getCurrentUser).mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const first = view()
  const signal = vi.mocked(getCurrentUser).mock.calls[0]![1]!
  first.unmount()
  resolve(customer)
  await Promise.resolve()
  expect(signal.aborted).toBe(true)
  expect(sessionStorage.getItem('septem-access-token')).toBeNull()
  expect(sessionStorage.getItem('elite-dev-access-token')).toBe('legacy')
})

it('replaces a retained legacy identity when a fresh login succeeds', async () => {
  sessionStorage.setItem('elite-dev-access-token', 'previous-user')
  vi.mocked(getCurrentUser).mockRejectedValueOnce(new ApiError('Unavailable', 503))
  view()
  expect(await screen.findByText(/Não foi possível restaurar sua sessão/)).toBeVisible()
  await enter(userEvent.setup())
  expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible()
  expect(sessionStorage.getItem('septem-access-token')).toBe('token')
  expect(sessionStorage.getItem('elite-dev-access-token')).toBeNull()
})
