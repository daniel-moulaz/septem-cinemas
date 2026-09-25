import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ToastContext, type ToastTone } from './toast'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

interface ToastProviderProps {
  children: ReactNode
}

const toastDurationMilliseconds = 4_500
const maximumVisibleToasts = 3

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextIdRef = useRef(0)
  const timersRef = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id)

    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }

    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = ++nextIdRef.current

      setToasts((current) => [
        ...current.slice(-(maximumVisibleToasts - 1)),
        { id, message, tone },
      ])

      const timer = window.setTimeout(
        () => dismiss(id),
        toastDurationMilliseconds,
      )
      timersRef.current.set(id, timer)
    },
    [dismiss],
  )

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer)
      }
      timersRef.current.clear()
    },
    [],
  )

  const value = useMemo(() => ({ notify }), [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-viewport"
        role="region"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Notificações"
      >
        {toasts.map((toast) => (
          <div
            className={`toast toast-${toast.tone}`}
            key={toast.id}
            data-toast-id={toast.id}
          >
            <span aria-hidden="true">
              {toast.tone === 'success'
                ? '✓'
                : toast.tone === 'error'
                  ? '!'
                  : 'i'}
            </span>
            <p>{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Fechar notificação"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
