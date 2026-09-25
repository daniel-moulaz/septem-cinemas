import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { PublicCatalog } from '../src/components/public/PublicCatalog'
import type { PublicSessionSummary } from '../src/api'

const sessions: PublicSessionSummary[] = [
  { id: 'one', startsAt: '2030-01-10T15:00:00Z', venueName: 'Paulista', roomName: 'Sala 1', capacity: 20, priceCents: 3000, movie: { tmdbId: 1, title: 'Matrix', posterPath: null, backdropPath: null, releaseDate: null, runtimeMinutes: 120 } },
  { id: 'two', startsAt: '2030-01-11T18:00:00Z', venueName: 'Centro', roomName: 'Sala 2', capacity: 20, priceCents: 2000, movie: { tmdbId: 2, title: 'Interestelar', posterPath: null, backdropPath: null, releaseDate: null, runtimeMinutes: 150 } },
]
const fetchMock = vi.fn<typeof fetch>()
const response = (values = sessions) => new Response(JSON.stringify({ sessions: values }))

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  fetchMock.mockReset().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => { vi.unstubAllGlobals() })

it('keeps skeletons, announces a slow start, recovers automatically, and clears the notice', async () => {
  vi.useFakeTimers()
  fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
  render(<PublicCatalog onOpenSession={vi.fn()} />)
  expect(screen.getByText('Carregando programação…')).toBeInTheDocument()
  expect(screen.queryByText(/Inicializando o servidor/)).not.toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  // A successful retry resolves at this boundary; it must remove the loading notice.
  expect(screen.getByRole('heading', { name: 'Matrix', level: 2 })).toBeVisible()
  expect(screen.queryByText(/Inicializando o servidor/)).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('announces initialization after 1.5s and aborts on navigation', async () => {
  vi.useFakeTimers()
  fetchMock.mockImplementation(() => new Promise(() => {}))
  const view = render(<PublicCatalog onOpenSession={vi.fn()} />)
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(screen.getByText(/Inicializando o servidor/)).toHaveAttribute('role', 'status')
  const signal = fetchMock.mock.calls[0]![1]!.signal!
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('shows the final error and permits a fresh manual retry', async () => {
  vi.useFakeTimers()
  fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }))
  render(<PublicCatalog onOpenSession={vi.fn()} />)
  await act(() => vi.runAllTimersAsync())
  expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível atualizar a programação')
  expect(fetchMock).toHaveBeenCalledTimes(5)
  expect(screen.queryByText(/Inicializando o servidor/)).not.toBeInTheDocument()
  fetchMock.mockImplementation(async () => response())
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('heading', { name: 'Matrix', level: 2 })).toBeVisible()
})

it('presents a truthful empty state', async () => {
  fetchMock.mockResolvedValue(response([]))
  render(<PublicCatalog onOpenSession={vi.fn()} />)
  expect(await screen.findByText('Ainda não há sessões publicadas.')).toBeVisible()
})

it('filters by venue, navigates to the selected session, and supports rail arrow keys', async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(<PublicCatalog onOpenSession={open} />)
  await user.selectOptions(await screen.findByLabelText('Cinema'), 'Centro')
  const board = screen.getByRole('region', { name: 'Programação' })
  await user.click(within(board).getByRole('button', { name: /Sessão de Interestelar/ }))
  expect(open).toHaveBeenCalledWith('two')
  const first = screen.getByRole('button', { name: 'Matrix Em destaque' })
  first.focus()
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('button', { name: 'Interestelar Em destaque' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Interestelar Em destaque' })).toHaveAttribute('aria-pressed', 'true')
})

it('searches on submit and recovers from empty search results', async () => {
  const user = userEvent.setup()
  render(<PublicCatalog onOpenSession={vi.fn()} />)
  await screen.findByLabelText('Cinema')
  fetchMock.mockResolvedValueOnce(response([]))
  await user.type(screen.getByRole('searchbox'), 'inexistente')
  await user.click(screen.getByRole('button', { name: 'Buscar' }))
  expect(await screen.findByText('Nenhum resultado para “inexistente”.')).toBeVisible()
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('q=inexistente')
  await user.click(screen.getByRole('button', { name: 'Ver toda a programação' }))
  expect(screen.getByLabelText('Cinema')).toBeVisible()
})

it('has no automatically detectable accessibility violations in the catalog', async () => {
  const { container } = render(<PublicCatalog onOpenSession={vi.fn()} />)
  await screen.findByLabelText('Cinema')
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
  expect(result.violations).toEqual([])
})
