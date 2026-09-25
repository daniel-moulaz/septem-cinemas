import { formatPrice, formatSessionDate } from './formatters'
import { MoviePicker } from './MoviePicker'
import { PublishedSession, RoomLayoutPreview, SessionOperationsPanel } from './SessionPresentation'
import { useSessionEditor, type SessionEditorProps } from './useSessionEditor'

export function SessionEditor(props: SessionEditorProps) {
  const { accessToken, onBack } = props
  const {
    session,
    selectedMovie,
    setSelectedMovie,
    form,
    fieldErrors,
    isDirty,
    clearFieldError,
    markDirty,
    isLoading,
    isBusy,
    isSaving,
    isPublishing,
    isDuplicating,
    loadError,
    actionError,
    notice,
    setActionError,
    setNotice,
    setIsLoading,
    setLoadError,
    setLoadRevision,
    isPublishDialogOpen,
    setIsPublishDialogOpen,
    publishDialogRef,
    setSelectingMovie,
    updateField,
    handleSubmit,
    duplicateThisSession,
    handlePublish,
  } = useSessionEditor(props)
  if (isLoading) {
    return (
      <section
        className="organizer-content content-state"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="section-kicker">Carregando</p>
        <h1>Abrindo a sessão…</h1>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="organizer-content content-state error-state">
        <p className="section-kicker">Sessão indisponível</p>
        <h1>Não foi possível abrir este rascunho</h1>
        <p role="alert">{loadError}</p>
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              setIsLoading(true)
              setLoadError(null)
              setLoadRevision((current) => current + 1)
            }}
          >
            Tentar novamente
          </button>
          <button type="button" className="secondary-button" onClick={onBack}>
            Voltar à lista
          </button>
        </div>
      </section>
    )
  }

  const isPublished = session?.status === 'PUBLISHED'
  // Publicar não bloqueia mais por si só: quem decide é a política de
  // editabilidade derivada pelo backend.
  const isStructurallyLocked = Boolean(session && !session.editability.allowed)
  const isLayoutLocked = Boolean(session && !session.editability.layoutEditable)
  const rows = Number(form.rows)
  const seatsPerRow = Number(form.seatsPerRow)
  const priceValue = Number(form.price)
  const pricePreview =
    form.price.trim() && Number.isFinite(priceValue) && priceValue >= 0
      ? formatPrice(Math.round(priceValue * 100))
      : null
  const capacity =
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 10 &&
    Number.isInteger(seatsPerRow) &&
    seatsPerRow >= 1 &&
    seatsPerRow <= 20
      ? rows * seatsPerRow
      : 0
  return (
    <section className="organizer-content" aria-labelledby="editor-title">
      <button
        type="button"
        className="back-button"
        onClick={onBack}
        disabled={isBusy}
      >
        <span aria-hidden="true">←</span> Minhas sessões
      </button>

      <div className="page-heading editor-heading">
        <div>
          <p className="section-kicker">
            {session ? 'Gestão da sessão' : 'Nova programação'}
          </p>
          <h1 id="editor-title">
            {isPublished
              ? 'Detalhes da sessão'
              : session
                ? 'Editar rascunho'
                : 'Criar sessão'}
          </h1>
          <p>
            {isPublished
              ? isStructurallyLocked
                ? 'Consulte os dados publicados em modo de leitura.'
                : 'Sessão publicada, ainda sem reservas: os dados continuam editáveis.'
              : 'Escolha o filme e configure apenas o necessário para a exibição.'}
          </p>
        </div>
        {isDirty || session ? (
          <div className="button-row">
            {isDirty ? (
              <span className="status-badge status-draft" role="status">
                Alterações não salvas
              </span>
            ) : null}
            {session ? (
              <span
                className={`status-badge status-${session.status.toLowerCase()}`}
              >
                {isPublished ? 'Publicada' : 'Rascunho'}
              </span>
            ) : null}
            {session ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void duplicateThisSession()}
                disabled={isBusy || isDuplicating || isDirty}
                title={isDirty ? 'Salve as alterações antes de duplicar.' : undefined}
              >
                {isDuplicating ? 'Duplicando…' : 'Duplicar sessão'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {notice ? (
        <p className="message success-message" role="status">
          {notice}
        </p>
      ) : null}

      {actionError && !isPublishDialogOpen ? (
        <p className="message error-message" role="alert">
          {actionError}
        </p>
      ) : null}

      {session && isPublished ? (
        <SessionOperationsPanel session={session} />
      ) : null}

      {isStructurallyLocked && session ? (
        <PublishedSession session={session} />
      ) : (
        <>
          {isPublished ? (
            <p className="editable-published-notice">
              <span aria-hidden="true">●</span>
              <span>
                <strong>Sessão publicada e ainda editável.</strong>
                {isLayoutLocked
                  ? ' Nenhuma reserva ou ingresso está ativo nesta sessão, então filme, horário, local e preço ainda podem ser alterados. Só o mapa de assentos ficou travado, porque lugares desta sessão já foram reservados antes.'
                  : ' Nenhuma reserva ou ingresso depende desta estrutura, então filme, horário, local, preço e layout ainda podem ser alterados.'}
                {' '}
                Assim que alguém reservar, a edição é bloqueada.
              </span>
            </p>
          ) : null}
          <MoviePicker
            accessToken={accessToken}
            disabled={isBusy}
            selectedMovie={selectedMovie}
            onSelect={(movie) => {
              setSelectedMovie(movie)
              clearFieldError('movie')
              markDirty(true)
              setNotice(null)
              setActionError(null)
            }}
            onSelectionBusyChange={setSelectingMovie}
          />

          {fieldErrors.movie ? (
            <p className="field-error movie-picker-error">
              {fieldErrors.movie}
            </p>
          ) : null}

          <form
            className="session-form"
            aria-busy={isBusy}
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="form-section-heading">
              <p className="section-kicker">Passo 2</p>
              <h2>Configure a exibição</h2>
            </div>

            <div className="form-grid">
              <div className="field field-wide">
                <label htmlFor="starts-at">Data e hora</label>
                <input
                  id="starts-at"
                  type="datetime-local"
                  value={form.startsAt}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('startsAt', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.startsAt)}
                  aria-describedby={
                    fieldErrors.startsAt ? 'starts-at-error' : undefined
                  }
                  required
                />
                {fieldErrors.startsAt ? (
                  <p id="starts-at-error" className="field-error">
                    {fieldErrors.startsAt}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="venue-name">Cinema / local</label>
                <input
                  id="venue-name"
                  value={form.venueName}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('venueName', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.venueName)}
                  aria-describedby={
                    fieldErrors.venueName ? 'venue-name-error' : undefined
                  }
                  maxLength={120}
                  placeholder="Ex.: SEPTEM Paulista"
                  required
                />
                {fieldErrors.venueName ? (
                  <p id="venue-name-error" className="field-error">
                    {fieldErrors.venueName}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="room-name">Sala</label>
                <input
                  id="room-name"
                  value={form.roomName}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('roomName', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.roomName)}
                  aria-describedby={
                    fieldErrors.roomName ? 'room-name-error' : undefined
                  }
                  maxLength={80}
                  placeholder="Ex.: Sala 2"
                  required
                />
                {fieldErrors.roomName ? (
                  <p id="room-name-error" className="field-error">
                    {fieldErrors.roomName}
                  </p>
                ) : null}
              </div>

              <div className="field field-wide">
                <label htmlFor="address">Endereço</label>
                <input
                  id="address"
                  value={form.address}
                  disabled={isBusy}
                  onChange={(event) =>
                    updateField('address', event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors.address)}
                  aria-describedby={
                    fieldErrors.address ? 'address-error' : undefined
                  }
                  maxLength={240}
                  placeholder="Rua, número e cidade"
                  required
                />
                {fieldErrors.address ? (
                  <p id="address-error" className="field-error">
                    {fieldErrors.address}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="price">Preço do ingresso (R$)</label>
                <input
                  id="price"
                  type="number"
                  value={form.price}
                  disabled={isBusy}
                  min="0"
                  max="100000"
                  step="0.01"
                  onChange={(event) => updateField('price', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.price)}
                  aria-describedby={
                    fieldErrors.price
                      ? 'price-error'
                      : pricePreview
                        ? 'price-preview'
                        : undefined
                  }
                  placeholder="30,00"
                  required
                />
                {fieldErrors.price ? (
                  <p id="price-error" className="field-error">
                    {fieldErrors.price}
                  </p>
                ) : pricePreview ? (
                  <small id="price-preview" className="field-hint">
                    Valor exibido: {pricePreview}
                  </small>
                ) : null}
              </div>
            </div>

            <fieldset className="layout-fieldset">
              <legend>Layout da sala</legend>
              <p id="layout-hint">
                {isLayoutLocked
                  ? 'Os lugares desta sessão já foram reservados alguma vez. O mapa não pode ser reconstruído sem apagar esse histórico; os demais campos continuam editáveis.'
                  : 'Os lugares serão gerados de A1 em diante. O layout pode ser alterado enquanto nenhum lugar tiver sido reservado.'}
              </p>
              <div className="layout-configurator">
                <div className="layout-fields">
                  <div className="field">
                    <label htmlFor="rows">Fileiras</label>
                    <input
                      id="rows"
                      type="number"
                      value={form.rows}
                      disabled={isBusy || isLayoutLocked}
                      min="1"
                      max="10"
                      onChange={(event) =>
                        updateField('rows', event.target.value)
                      }
                      aria-invalid={Boolean(fieldErrors.rows)}
                      aria-describedby={
                        fieldErrors.rows
                          ? 'rows-error layout-hint'
                          : 'layout-hint'
                      }
                      required
                    />
                    {fieldErrors.rows ? (
                      <p id="rows-error" className="field-error">
                        {fieldErrors.rows}
                      </p>
                    ) : null}
                  </div>
                  <span aria-hidden="true">×</span>
                  <div className="field">
                    <label htmlFor="seats-per-row">Assentos por fileira</label>
                    <input
                      id="seats-per-row"
                      type="number"
                      value={form.seatsPerRow}
                      disabled={isBusy || isLayoutLocked}
                      min="1"
                      max="20"
                      onChange={(event) =>
                        updateField('seatsPerRow', event.target.value)
                      }
                      aria-invalid={Boolean(fieldErrors.seatsPerRow)}
                      aria-describedby={
                        fieldErrors.seatsPerRow
                          ? 'seats-per-row-error layout-hint'
                          : 'layout-hint'
                      }
                      required
                    />
                    {fieldErrors.seatsPerRow ? (
                      <p id="seats-per-row-error" className="field-error">
                        {fieldErrors.seatsPerRow}
                      </p>
                    ) : null}
                  </div>
                  <div className="capacity-summary" aria-live="polite">
                    <strong>{capacity}</strong>
                    <span>lugares</span>
                  </div>
                </div>
                <RoomLayoutPreview rows={rows} seatsPerRow={seatsPerRow} />
              </div>
            </fieldset>

            <div className="editor-actions">
              <button type="submit" disabled={isBusy}>
                {isSaving
                  ? 'Salvando…'
                  : session
                    ? 'Salvar alterações'
                    : 'Salvar rascunho'}
              </button>
              {session && !isPublished ? (
                <div className="publish-action">
                  <p>Revise e salve qualquer alteração antes de publicar.</p>
                  <button
                    type="button"
                    className="publish-button"
                    onClick={() => {
                      setActionError(null)
                      setIsPublishDialogOpen(true)
                    }}
                    disabled={isBusy || isDirty}
                  >
                    Publicar sessão
                  </button>
                </div>
              ) : null}
            </div>
          </form>
        </>
      )}

      {session && !isPublished ? (
        <dialog
          ref={publishDialogRef}
          className="organizer-publish-dialog"
          aria-labelledby="publish-dialog-title"
          aria-describedby="publish-dialog-description"
          aria-busy={isPublishing}
          onCancel={(event) => {
            if (isPublishing) {
              event.preventDefault()
              return
            }

            setIsPublishDialogOpen(false)
          }}
          onClose={() => setIsPublishDialogOpen(false)}
        >
          <div className="publish-dialog-content">
            <p className="section-kicker">Publicação definitiva</p>
            <h2 id="publish-dialog-title">Publicar esta sessão?</h2>
            <p id="publish-dialog-description">
              Confira os dados principais antes de disponibilizar a sessão na
              programação.
            </p>

            <dl className="publish-dialog-summary">
              <div>
                <dt>Filme</dt>
                <dd>{session.movie.title}</dd>
              </div>
              <div>
                <dt>Data e hora</dt>
                <dd>{formatSessionDate(session.startsAt)}</dd>
              </div>
              <div>
                <dt>Local</dt>
                <dd>
                  {session.venueName} · {session.roomName}
                </dd>
              </div>
              <div>
                <dt>Ingresso</dt>
                <dd>{formatPrice(session.priceCents)}</dd>
              </div>
              <div>
                <dt>Capacidade</dt>
                <dd>{session.capacity} lugares</dd>
              </div>
            </dl>

            <p className="publish-dialog-warning">
              <strong>Após publicar,</strong> a sessão entra na programação
              pública. Filme, horário, preço, local e assentos continuam
              editáveis até a primeira reserva ou ingresso.
            </p>

            {actionError ? (
              <p className="message error-message" role="alert">
                {actionError}
              </p>
            ) : null}

            <div className="publish-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={isPublishing}
                onClick={() => setIsPublishDialogOpen(false)}
              >
                Voltar e revisar
              </button>
              <button
                type="button"
                className="publish-button"
                disabled={isPublishing}
                onClick={() => void handlePublish()}
              >
                {isPublishing ? 'Publicando…' : 'Confirmar publicação'}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </section>
  )
}
