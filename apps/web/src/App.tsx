import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  ApiError,
  getCurrentUser,
  login,
  setUnauthorizedHandler,
  type AuthenticatedUser,
  type Reservation,
} from './api'
import { BrandLockup } from './components/common/BrandLockup'
import { useToast } from './components/common/toast'
import { PublicCatalog } from './components/public/PublicCatalog'
import { PublicHeader } from './components/public/PublicHeader'
import { TmdbAttribution } from './components/public/TmdbAttribution'

const GateArea = lazy(() =>
  import('./components/gate/GateArea').then((module) => ({
    default: module.GateArea,
  })),
)
const OrganizerArea = lazy(() =>
  import('./components/organizer/OrganizerArea').then((module) => ({
    default: module.OrganizerArea,
  })),
)
const ReservationSummary = lazy(() =>
  import('./components/public/ReservationSummary').then((module) => ({
    default: module.ReservationSummary,
  })),
)
const SessionDetail = lazy(() =>
  import('./components/public/SessionDetail').then((module) => ({
    default: module.SessionDetail,
  })),
)
const SharedTicket = lazy(() =>
  import('./components/tickets/SharedTicket').then((module) => ({
    default: module.SharedTicket,
  })),
)
const TicketDetail = lazy(() =>
  import('./components/tickets/TicketDetail').then((module) => ({
    default: module.TicketDetail,
  })),
)
const TicketList = lazy(() =>
  import('./components/tickets/TicketList').then((module) => ({
    default: module.TicketList,
  })),
)

const accessTokenKey = 'septem-access-token'
const legacyAccessTokenKey = 'elite-dev-access-token'

function readAccessToken() {
  try {
    return sessionStorage.getItem(accessTokenKey) ?? sessionStorage.getItem(legacyAccessTokenKey)
  } catch { return null }
}

function storeAccessToken(token: string | null) {
  if (token === null) {
    for (const key of [accessTokenKey, legacyAccessTokenKey]) {
      try { sessionStorage.removeItem(key) } catch { /* Storage may be disabled. */ }
    }
    return
  }
  try {
    sessionStorage.setItem(accessTokenKey, token)
    // Only discard the fallback after the current token was stored, or on
    // explicit logout/invalidation. A failed write preserves recovery.
    sessionStorage.removeItem(legacyAccessTokenKey)
  } catch {
    // Login can still live in memory when browser storage is unavailable.
  }
}

type AuthState =
  | { status: 'restoring' }
  | { status: 'anonymous'; notice?: string }
  | {
      status: 'authenticated'
      user: AuthenticatedUser
      accessToken: string
    }

type PublicRoute =
  | { name: 'catalog' }
  | { name: 'login' }
  | { name: 'session'; sessionId: string }
  | { name: 'reservation'; reservationId: string }
  | { name: 'tickets' }
  | { name: 'ticket'; ticketId: string }
  | { name: 'shared'; token: string }

function initialAuthState(): AuthState {
  return readAccessToken()
    ? { status: 'restoring' }
    : { status: 'anonymous' }
}

function parsePublicRoute(pathname = window.location.pathname): PublicRoute {
  const segments = pathname.split('/').filter(Boolean)

  if (segments.length === 1 && segments[0] === 'login') {
    return { name: 'login' }
  }

  if (segments.length === 2 && segments[0] === 'sessions') {
    return { name: 'session', sessionId: segments[1]! }
  }

  if (segments.length === 2 && segments[0] === 'reservations') {
    return {
      name: 'reservation',
      reservationId: segments[1]!,
    }
  }

  if (segments.length === 2 && segments[0] === 'shared') {
    return { name: 'shared', token: segments[1]! }
  }

  if (segments.length === 2 && segments[0] === 'me' && segments[1] === 'tickets') {
    return { name: 'tickets' }
  }

  if (
    segments.length === 3 &&
    segments[0] === 'me' &&
    segments[1] === 'tickets'
  ) {
    return { name: 'ticket', ticketId: segments[2]! }
  }

  return { name: 'catalog' }
}

function routePath(route: PublicRoute): string {
  if (route.name === 'session') {
    return `/sessions/${encodeURIComponent(route.sessionId)}`
  }

  if (route.name === 'reservation') {
    return `/reservations/${encodeURIComponent(route.reservationId)}`
  }

  if (route.name === 'shared') {
    return `/shared/${encodeURIComponent(route.token)}`
  }

  if (route.name === 'ticket') {
    return `/me/tickets/${encodeURIComponent(route.ticketId)}`
  }

  if (route.name === 'tickets') {
    return '/me/tickets'
  }

  return route.name === 'login' ? '/login' : '/'
}

function routeTitle(route: PublicRoute): string {
  switch (route.name) {
    case 'login':
      return 'SEPTEM | Entrar'
    case 'session':
      return 'SEPTEM | Escolha de assentos'
    case 'reservation':
      return 'SEPTEM | Checkout'
    case 'tickets':
      return 'SEPTEM | Meus ingressos'
    case 'ticket':
      return 'SEPTEM | Ingresso'
    case 'shared':
      return 'SEPTEM | Ingresso compartilhado'
    default:
      return 'SEPTEM | Programação'
  }
}

function RouteLoading({ label }: { label: string }) {
  return (
    <div className="public-content route-loading" aria-busy="true">
      <div className="content-state public-state" aria-live="polite">
        <p className="section-kicker">SEPTEM</p>
        <h1>{label}</h1>
      </div>
    </div>
  )
}

function StandaloneRouteLoading({ label }: { label: string }) {
  return (
    <main
      id="main-content"
      className="app-shell route-loading"
      aria-busy="true"
      tabIndex={-1}
    >
      <section className="auth-panel status-panel" aria-live="polite">
        <BrandLockup />
        <p className="section-kicker">SEPTEM</p>
        <h1>{label}</h1>
      </section>
    </main>
  )
}

function customerRouteLoadingLabel(route: PublicRoute): string {
  switch (route.name) {
    case 'reservation':
      return 'Abrindo o checkout…'
    case 'tickets':
      return 'Abrindo seus ingressos…'
    case 'ticket':
      return 'Preparando seu ingresso…'
    case 'session':
      return 'Preparando a sessão…'
    default:
      return 'Carregando a programação…'
  }
}

interface LoginScreenProps {
  notice: string | undefined
  errorMessage: string | null
  hasCredentialError: boolean
  isSubmitting: boolean
  onBack: () => void
  onClearError: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const demoAccounts = [
  { label: 'Organizador', email: 'organizer@demo.local' },
  { label: 'Cliente', email: 'customer1@demo.local' },
  { label: 'Cliente com ingresso', email: 'customer2@demo.local' },
  { label: 'Portaria', email: 'gate@demo.local' },
] as const

function LoginScreen({
  notice,
  errorMessage,
  hasCredentialError,
  isSubmitting,
  onBack,
  onClearError,
  onSubmit,
}: LoginScreenProps) {
  const { notify } = useToast()
  const submitButtonRef = useRef<HTMLButtonElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  function fillDemoAccount(accountEmail: string) {
    onClearError()
    setEmail(accountEmail)
    setPassword('Demo@123')
    notify('Credenciais de demonstração preenchidas.', 'success')
    window.requestAnimationFrame(() => submitButtonRef.current?.focus())
  }

  return (
    <main id="main-content" className="app-shell login-shell" tabIndex={-1}>
      <section className="auth-panel">
        <div className="login-panel-header">
          <BrandLockup />
          <button type="button" className="back-button" onClick={onBack}>
            <span aria-hidden="true">←</span> Programação
          </button>
        </div>
        <p className="eyebrow">Acesso à plataforma</p>
        <h1>Entre na SEPTEM</h1>
        <p className="intro">
          Use uma conta de demonstração para comprar ingressos, organizar
          sessões ou operar a portaria.
        </p>

        {notice ? (
          <p className="message error-message" role="alert">
            {notice}
          </p>
        ) : null}

        <form onSubmit={onSubmit} aria-busy={isSubmitting}>
          <div className="field">
            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                onClearError()
              }}
              autoComplete="email"
              aria-invalid={hasCredentialError}
              aria-describedby={errorMessage ? 'login-error' : undefined}
              required
              disabled={isSubmitting}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Senha</label>
            <div className="password-field">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  onClearError()
                }}
                autoComplete="current-password"
                aria-invalid={hasCredentialError}
                aria-describedby={errorMessage ? 'login-error' : undefined}
                required
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((current) => !current)}
                aria-pressed={showPassword}
                aria-controls="password"
                disabled={isSubmitting}
              >
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
          </div>

          {errorMessage ? (
            <p id="login-error" className="message error-message" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <button ref={submitButtonRef} type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <div className="demo-access" aria-labelledby="demo-access-title">
          <div>
            <strong id="demo-access-title">Acessos de demonstração</strong>
            <small>Senha comum: <code>Demo@123</code></small>
          </div>
          <div className="demo-account-grid">
            {demoAccounts.map((account) => (
              <button
                type="button"
                className="demo-account-button"
                key={account.email}
                onClick={() => fillDemoAccount(account.email)}
                disabled={isSubmitting}
              >
                <span>{account.label}</span>
                <small>{account.email}</small>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState)
  const [route, setRoute] = useState<PublicRoute>(parsePublicRoute)
  const [loginReturnPath, setLoginReturnPath] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginErrorKind, setLoginErrorKind] = useState<
    'credentials' | 'system' | null
  >(null)
  const [createdReservation, setCreatedReservation] =
    useState<Reservation | null>(null)

  const navigate = useCallback((path: string, replace = false) => {
    if (replace) {
      window.history.replaceState(null, '', path)
    } else {
      window.history.pushState(null, '', path)
    }
    setRoute(parsePublicRoute(path))
    window.scrollTo({ top: 0, behavior: 'auto' })
    window.requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus({ preventScroll: true })
    })
  }, [])

  const openHome = useCallback(() => {
    if (route.name === 'catalog') {
      window.scrollTo({ top: 0, behavior: 'auto' })
      document.getElementById('main-content')?.focus({ preventScroll: true })
      return
    }

    navigate('/')
  }, [navigate, route.name])

  const clearAuthentication = useCallback(() => {
    storeAccessToken(null)
    setLoginError(null)
    setLoginErrorKind(null)
    setAuthState({ status: 'anonymous' })
  }, [])

  const expireAuthentication = useCallback(() => {
    const returnPath = `${window.location.pathname}${window.location.search}`
    storeAccessToken(null)
    setLoginError(null)
    setLoginErrorKind(null)
    setLoginReturnPath(returnPath === '/login' ? '/' : returnPath)
    setAuthState({
      status: 'anonymous',
      notice: 'Sua sessão expirou. Entre novamente para continuar.',
    })
    navigate('/login', true)
  }, [navigate])

  useEffect(() => {
    function handlePopState() {
      setRoute(parsePublicRoute())
      window.requestAnimationFrame(() => {
        document.getElementById('main-content')?.focus({ preventScroll: true })
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(expireAuthentication)
    return () => setUnauthorizedHandler(null)
  }, [expireAuthentication])

  useEffect(() => {
    if (authState.status === 'authenticated') {
      document.title =
        authState.user.role === 'ORGANIZER'
          ? 'SEPTEM | Organização'
          : authState.user.role === 'GATE'
            ? 'SEPTEM | Portaria'
            : routeTitle(route)
      return
    }

    document.title = routeTitle(route)
  }, [authState, route])

  useEffect(() => {
    const accessToken = readAccessToken()

    if (!accessToken) {
      return
    }

    const controller = new AbortController()

    getCurrentUser(accessToken, controller.signal)
      .then((user) => {
        if (controller.signal.aborted) return
        storeAccessToken(accessToken)
        setAuthState({ status: 'authenticated', user, accessToken })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        if (error instanceof ApiError && error.status === 401) {
          storeAccessToken(null)
        }

        setAuthState({
          status: 'anonymous',
          notice:
            error instanceof ApiError && error.status === 401
              ? 'Sua sessão expirou. Entre novamente para continuar.'
              : 'Não foi possível restaurar sua sessão. Você ainda pode consultar a programação.',
        })
      })

    return () => controller.abort()
  }, [])

  function requestLogin(returnPath: string) {
    setLoginReturnPath(returnPath)
    setLoginError(null)
    setLoginErrorKind(null)
    navigate('/login')
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setLoginError(null)
    setLoginErrorKind(null)

    const form = event.currentTarget
    const formData = new FormData(form)
    const email = String(formData.get('email') ?? '')
    const password = String(formData.get('password') ?? '')

    try {
      const result = await login(email, password)
      storeAccessToken(result.accessToken)
      form.reset()
      setAuthState({
        status: 'authenticated',
        user: result.user,
        accessToken: result.accessToken,
      })

      navigate(
        result.user.role === 'CUSTOMER' ? (loginReturnPath ?? '/') : '/',
        true,
      )
      setLoginReturnPath(null)
    } catch (error) {
      setLoginErrorKind(
        error instanceof ApiError && error.status === 401
          ? 'credentials'
          : 'system',
      )
      setLoginError(
        error instanceof ApiError
          ? error.message
          : 'Não foi possível conectar à API. Tente novamente.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleLogout() {
    clearAuthentication()
    setCreatedReservation(null)
    navigate('/')
  }

  function handleReservationCreated(reservation: Reservation) {
    setCreatedReservation(reservation)
    navigate(`/reservations/${reservation.id}`)
  }

  if (authState.status === 'restoring') {
    return (
      <main
        id="main-content"
        className="app-shell"
        aria-busy="true"
        tabIndex={-1}
      >
        <section className="auth-panel status-panel" aria-live="polite">
          <BrandLockup />
          <p className="eyebrow">Acesso seguro</p>
          <h1>Validando sua sessão</h1>
          <p>Aguarde enquanto confirmamos seu acesso.</p>
        </section>
      </main>
    )
  }

  if (route.name === 'shared') {
    return (
      <div className="public-shell">
        <PublicHeader
          user={undefined}
          onHome={openHome}
          onLogin={() => requestLogin(routePath(route))}
          onLogout={handleLogout}
          onTickets={() => navigate('/me/tickets')}
          publicOnly
        />
        <main id="main-content" tabIndex={-1}>
          <Suspense fallback={<RouteLoading label="Abrindo ingresso…" />}>
            <SharedTicket
              key={route.token}
              token={route.token}
              onBack={() => navigate('/')}
            />
          </Suspense>
        </main>
        <TmdbAttribution />
      </div>
    )
  }

  if (authState.status === 'authenticated') {
    if (authState.user.role === 'ORGANIZER') {
      return (
        <Suspense
          fallback={<StandaloneRouteLoading label="Abrindo a organização…" />}
        >
          <OrganizerArea
            accessToken={authState.accessToken}
            user={authState.user}
            onLogout={handleLogout}
          />
        </Suspense>
      )
    }

    if (authState.user.role === 'GATE') {
      return (
        <Suspense
          fallback={<StandaloneRouteLoading label="Preparando a portaria…" />}
        >
          <GateArea
            accessToken={authState.accessToken}
            user={authState.user}
            onLogout={handleLogout}
          />
        </Suspense>
      )
    }
  }

  if (route.name === 'login') {
    return (
      <LoginScreen
        notice={authState.status === 'anonymous' ? authState.notice : undefined}
        errorMessage={loginError}
        hasCredentialError={loginErrorKind === 'credentials'}
        isSubmitting={isSubmitting}
        onBack={() => navigate(loginReturnPath ?? '/')}
        onClearError={() => {
          setLoginError(null)
          setLoginErrorKind(null)
        }}
        onSubmit={(event) => void handleLogin(event)}
      />
    )
  }

  const customer =
    authState.status === 'authenticated' ? authState.user : undefined
  const accessToken =
    authState.status === 'authenticated' ? authState.accessToken : undefined

  return (
    /*
     * A rota de sessão fixa a barra de reserva no rodapé em telas estreitas. O
     * modificador reserva a altura dessa barra no fim da página, senão o
     * rodapé — incluindo a atribuição obrigatória da TMDb — termina embaixo
     * dela e nunca chega a ser visto.
     */
    <div
      className={`public-shell${
        route.name === 'session' ? ' has-booking-bar' : ''
      }`}
    >
      <PublicHeader
        user={customer}
        onHome={openHome}
        onLogin={() => requestLogin(routePath(route))}
        onLogout={handleLogout}
        onTickets={() => navigate('/me/tickets')}
        activeItem={
          route.name === 'tickets' || route.name === 'ticket'
            ? 'tickets'
            : 'programming'
        }
      />
      <main id="main-content" tabIndex={-1}>
        <Suspense
          fallback={<RouteLoading label={customerRouteLoadingLabel(route)} />}
        >
        {route.name === 'session' ? (
          <SessionDetail
            key={route.sessionId}
            sessionId={route.sessionId}
            user={customer}
            accessToken={accessToken}
            onBack={() => navigate('/')}
            onRequireLogin={() => requestLogin(routePath(route))}
            onReservationCreated={handleReservationCreated}
          />
        ) : route.name === 'reservation' && customer && accessToken ? (
          <ReservationSummary
            key={route.reservationId}
            reservationId={route.reservationId}
            accessToken={accessToken}
            initialReservation={
              createdReservation?.id === route.reservationId
                ? createdReservation
                : undefined
            }
            onBackToCatalog={() => navigate('/')}
            onBackToSession={(sessionId) => navigate(`/sessions/${sessionId}`)}
            onOpenTicket={(ticketId) => navigate(`/me/tickets/${ticketId}`)}
            onOpenTickets={() => navigate('/me/tickets')}
          />
        ) : route.name === 'tickets' && customer && accessToken ? (
          <TicketList
            accessToken={accessToken}
            onBack={() => navigate('/')}
            onOpenTicket={(ticketId) => navigate(`/me/tickets/${ticketId}`)}
          />
        ) : route.name === 'ticket' && customer && accessToken ? (
          <TicketDetail
            key={route.ticketId}
            accessToken={accessToken}
            ticketId={route.ticketId}
            onBack={() => navigate('/me/tickets')}
          />
        ) : route.name === 'reservation' ? (
          <div className="public-content">
            <div className="content-state public-state">
              <p className="section-kicker">Reserva protegida</p>
              <h1>Entre para consultar esta reserva.</h1>
              <p>Somente o cliente que criou o hold pode visualizar seus dados.</p>
              <button type="button" onClick={() => requestLogin(routePath(route))}>
                Entrar como cliente
              </button>
            </div>
          </div>
        ) : route.name === 'tickets' || route.name === 'ticket' ? (
          <div className="public-content">
            <div className="content-state public-state">
              <p className="section-kicker">Bilheteria pessoal</p>
              <h1>Entre para acessar seus ingressos.</h1>
              <p>Somente o titular pode consultar o QR e gerenciar compartilhamentos.</p>
              <button type="button" onClick={() => requestLogin(routePath(route))}>
                Entrar como cliente
              </button>
            </div>
          </div>
        ) : (
          <PublicCatalog
            onOpenSession={(sessionId) => navigate(`/sessions/${sessionId}`)}
          />
        )}
        </Suspense>
      </main>
      <TmdbAttribution />
    </div>
  )
}
