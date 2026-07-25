import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

/**
 * Live per-company board over WebSockets. The server (see start/socket.ts +
 * BookingBoardListener) attaches socket.io to the HTTP server, joins each
 * connection to its `tenant:<uuid>` room from the handshake `auth.tenantId`, and
 * broadcasts PII-free `booking:changed` events on every committed booking write.
 *
 * The hook connects same-origin, authenticates with the company's own id (from
 * shared props), and calls `onEvent` for each named event. Detail is never on the
 * wire, so a client re-reads the REST list when notified — the classic
 * "invalidate, then refetch" live pattern. Returns the connection status for a
 * live/offline indicator.
 */
export type BoardStatus = 'connecting' | 'live' | 'offline'

const LIVE_EVENTS = ['booking:changed', 'board:pong'] as const

export function useLiveBoard(
  tenantId: string | undefined | null,
  onEvent: (name: string, payload: unknown) => void
): BoardStatus {
  const [status, setStatus] = useState<BoardStatus>('connecting')
  // Keep the latest callback without re-subscribing the socket on every render.
  const cb = useRef(onEvent)
  cb.current = onEvent

  useEffect(() => {
    if (!tenantId) {
      setStatus('offline')
      return
    }
    const socket: Socket = io({
      auth: { tenantId },
      // Prefer a real socket; fall back to polling behind proxies that buffer.
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    })
    socket.on('connect', () => setStatus('live'))
    socket.on('disconnect', () => setStatus('offline'))
    socket.on('connect_error', () => setStatus('offline'))
    for (const name of LIVE_EVENTS) {
      socket.on(name, (payload: unknown) => cb.current(name, payload))
    }
    return () => {
      socket.close()
    }
  }, [tenantId])

  return status
}
