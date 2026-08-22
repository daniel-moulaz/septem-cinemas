import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// O jsdom não implementa matchMedia, usado pela portaria para adaptar a
// leitura em tablet. Sem este stub, qualquer render de GateArea falha.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// `EventSource` não existe no jsdom. Os componentes já tratam sua ausência
// (`typeof EventSource === 'undefined'`) e caem no polling, que é justamente
// o caminho que os testes exercitam.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
