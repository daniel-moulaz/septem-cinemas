const retryStatuses = new Set([408, 425, 429, 500, 502, 503, 504])
const backoff = [1_500, 3_000, 5_000, 8_000]
const attemptTimeout = 8_000

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}

/** Only public GETs enter this policy; mutations never pass through it. */
export async function publicRead<T>(
  url: string,
  readResponse: (response: Response) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException(
      'O servidor demorou para responder.', 'TimeoutError',
    )), attemptTimeout)
    const attemptSignal = signal
      ? AbortSignal.any([signal, timeout.signal])
      : timeout.signal
    let delay = backoff[attempt]
    try {
      const response = await fetch(url, { signal: attemptSignal })
      signal?.throwIfAborted()
      const serverDelay = retryAfter(response)
      // A long Retry-After ends automatic recovery instead of retrying early.
      if (!retryStatuses.has(response.status) || delay === undefined || serverDelay > 30_000) {
        return await readResponse(response)
      }
      delay = Math.max(delay, serverDelay)
      await response.body?.cancel()
    } catch (error) {
      signal?.throwIfAborted()
      if (delay === undefined || !(error instanceof TypeError || timeout.signal.aborted)) {
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
    await wait(delay! + Math.floor(Math.random() * 250), signal)
  }
}
