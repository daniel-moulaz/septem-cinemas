import { useEffect, useRef, useState } from 'react'
import type { AuthenticatedUser } from '../../api'
import { BrandLockup } from '../common/BrandLockup'
import { useToast } from '../common/toast'
import { TmdbAttribution } from '../public/TmdbAttribution'
import { SessionEditor } from './SessionEditor'
import { SessionList } from './SessionList'

interface OrganizerAreaProps {
  accessToken: string
  user: AuthenticatedUser
  onLogout: () => void
}

type OrganizerScreen =
  | { name: 'sessions' }
  | { name: 'create' }
  | { name: 'details'; sessionId: string }

function screenKey(screen: OrganizerScreen): string {
  return screen.name === 'details'
    ? `${screen.name}:${screen.sessionId}`
    : screen.name
}

export function OrganizerArea({
  accessToken,
  user,
  onLogout,
}: OrganizerAreaProps) {
  const { notify } = useToast()
  const [screen, setScreen] = useState<OrganizerScreen>({ name: 'sessions' })
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isEditorBusy, setIsEditorBusy] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const previousScreenKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const currentScreenKey = screenKey(screen)

    if (previousScreenKeyRef.current !== currentScreenKey) {
      window.scrollTo({ top: 0, behavior: 'auto' })
      mainRef.current?.focus({ preventScroll: true })
      previousScreenKeyRef.current = currentScreenKey
    }
  }, [screen])

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  function confirmDiscardChanges(): boolean {
    return (
      !hasUnsavedChanges ||
      window.confirm(
        'Você tem alterações não salvas. Deseja sair e descartar essas alterações?',
      )
    )
  }

  function changeScreen(nextScreen: OrganizerScreen) {
    if (screenKey(screen) === screenKey(nextScreen)) {
      return
    }

    if (isEditorBusy) {
      notify('Aguarde a operação atual terminar antes de sair.', 'info')
      return
    }

    if (!confirmDiscardChanges()) {
      return
    }

    setHasUnsavedChanges(false)
    setScreen(nextScreen)
  }

  function handleLogout() {
    if (isEditorBusy) {
      notify('Aguarde a operação atual terminar antes de sair.', 'info')
      return
    }

    if (!confirmDiscardChanges()) {
      return
    }

    setHasUnsavedChanges(false)
    onLogout()
  }

  function handleSessionCreated(sessionId: string) {
    setHasUnsavedChanges(false)
    setScreen({ name: 'details', sessionId })
  }

  return (
    <div className="organizer-shell">
      <header className="topbar">
        <div className="header-primary">
          <button
            type="button"
            className="brand-button"
            onClick={() => changeScreen({ name: 'sessions' })}
            disabled={isEditorBusy}
            aria-label="SEPTEM — ir para Minhas sessões"
          >
            <BrandLockup context="Organização" />
          </button>
          <nav className="header-nav" aria-label="Navegação do organizador">
            <button
              type="button"
              className={screen.name !== 'create' ? 'is-active' : undefined}
              aria-current={screen.name !== 'create' ? 'page' : undefined}
              onClick={() => changeScreen({ name: 'sessions' })}
              disabled={isEditorBusy}
            >
              Minhas sessões
            </button>
            <button
              type="button"
              className={screen.name === 'create' ? 'is-active' : undefined}
              aria-current={screen.name === 'create' ? 'page' : undefined}
              onClick={() => changeScreen({ name: 'create' })}
              disabled={isEditorBusy}
            >
              Criar sessão
            </button>
          </nav>
        </div>
        <div className="account-actions">
          <span className="account-name" title={user.email}>{user.name}</span>
          <button
            type="button"
            className="text-button"
            onClick={handleLogout}
            disabled={isEditorBusy}
          >
            Sair
          </button>
        </div>
      </header>

      <main id="main-content" ref={mainRef} tabIndex={-1}>
        {screen.name === 'sessions' ? (
          <SessionList
            accessToken={accessToken}
            onCreate={() => changeScreen({ name: 'create' })}
            onOpen={(sessionId) =>
              changeScreen({ name: 'details', sessionId })
            }
          />
        ) : screen.name === 'details' ? (
          <SessionEditor
            key={`session-${screen.sessionId}`}
            accessToken={accessToken}
            sessionId={screen.sessionId}
            onCreated={handleSessionCreated}
            onBack={() => changeScreen({ name: 'sessions' })}
            onDirtyChange={setHasUnsavedChanges}
            onBusyChange={setIsEditorBusy}
          />
        ) : (
          <SessionEditor
            key="new-session"
            accessToken={accessToken}
            onBack={() => changeScreen({ name: 'sessions' })}
            onCreated={handleSessionCreated}
            onDirtyChange={setHasUnsavedChanges}
            onBusyChange={setIsEditorBusy}
          />
        )}
      </main>

      <TmdbAttribution />
    </div>
  )
}
