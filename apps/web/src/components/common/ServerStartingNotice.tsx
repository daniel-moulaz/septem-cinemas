import { useEffect, useState } from 'react'

/** Mount only during a public load, outside aria-busy containers. */
export function ServerStartingNotice() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1_500)
    return () => clearTimeout(timer)
  }, [])

  return <p role="status" aria-live="polite" className="server-starting-notice">
    {visible ? 'Inicializando o servidor… o primeiro acesso pode levar alguns segundos.' : ''}
  </p>
}
