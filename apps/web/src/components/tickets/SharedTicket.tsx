import { useEffect, useState } from 'react'
import { ApiError, getSharedTicket, type SharedTicket as SharedTicketData } from '../../api'
import { DigitalTicket } from './DigitalTicket'
import { ServerStartingNotice } from '../common/ServerStartingNotice'

interface SharedTicketProps {
  token: string
  onBack: () => void
}

interface UnavailableMessage {
  kicker: string
  title: string
  description: string
  retryable: boolean
}

function unavailableMessage(error: unknown): UnavailableMessage {
  if (error instanceof ApiError && error.code === 'SHARED_LINK_EXPIRED') {
    return {
      kicker: 'Link expirado',
      title: 'Este compartilhamento chegou ao fim.',
      description: 'Peça ao titular do ingresso para gerar um novo link.',
      retryable: false,
    }
  }

  if (error instanceof ApiError && error.code === 'SHARED_LINK_REVOKED') {
    return {
      kicker: 'Link revogado',
      title: 'Este compartilhamento foi desativado.',
      description: 'Peça ao titular do ingresso para gerar outro link.',
      retryable: false,
    }
  }

  if (error instanceof ApiError && error.status === 404) {
    return {
      kicker: 'Link inexistente',
      title: 'Não encontramos este ingresso.',
      description: 'Confira se o endereço foi copiado por completo.',
      retryable: false,
    }
  }

  return {
    kicker: 'Falha de conexão',
    title: 'Não foi possível abrir o ingresso.',
    description: 'Verifique sua conexão e tente novamente.',
    retryable: true,
  }
}

export function SharedTicket({ token, onBack }: SharedTicketProps) {
  const [ticket, setTicket] = useState<SharedTicketData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<UnavailableMessage | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    getSharedTicket(token, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setTicket(result)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setMessage(unavailableMessage(error))
        setStatus('error')
      })

    return () => controller.abort()
  }, [reloadKey, token])

  if (status === 'loading') {
    return (
      <div className="public-content shared-ticket-page">
        <ServerStartingNotice />
        <div className="content-state public-state" aria-busy="true" aria-live="polite">
          <p className="section-kicker">Ingresso compartilhado</p>
          <h1>Validando o link…</h1>
        </div>
      </div>
    )
  }

  if (status === 'error' || !ticket) {
    const content = message ?? unavailableMessage(null)

    return (
      <div className="public-content shared-ticket-page">
        <div className="content-state public-state" role="alert">
          <p className="section-kicker">{content.kicker}</p>
          <h1>{content.title}</h1>
          <p>{content.description}</p>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onBack}>
              Ver programação
            </button>
            {content.retryable ? (
              <button
                type="button"
                onClick={() => {
                  setStatus('loading')
                  setMessage(null)
                  setReloadKey((value) => value + 1)
                }}
              >
                Tentar novamente
              </button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="public-content shared-ticket-page">
      <div className="shared-ticket-privacy" role="note">
        <strong>Ingresso compartilhado</strong>
        <span>Link público sem nome, e-mail ou dados do comprador.</span>
      </div>
      <DigitalTicket
        shared
        ticket={{
          status: ticket.status,
          manualCode: ticket.manualCode,
          qrToken: ticket.qrToken,
          seatLabel: ticket.seat.label,
          session: ticket.session,
        }}
      />
    </div>
  )
}
