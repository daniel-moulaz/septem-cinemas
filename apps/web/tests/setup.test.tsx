import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

/**
 * Sanidade da infraestrutura: confirma que jsdom, JSX, Testing Library e os
 * matchers de jest-dom estão realmente ligados antes de qualquer teste de
 * jornada depender disso.
 */
describe('infraestrutura de testes do frontend', () => {
  it('renderiza JSX em jsdom e consulta por papel acessível', () => {
    render(<button type="button">Validar ingresso</button>)

    expect(
      screen.getByRole('button', { name: 'Validar ingresso' }),
    ).toBeInTheDocument()
  })

  it('expõe os stubs de ambiente que o jsdom não implementa', () => {
    expect(typeof window.matchMedia).toBe('function')
    expect(window.matchMedia('(min-width: 48rem)').matches).toBe(false)
  })
})
