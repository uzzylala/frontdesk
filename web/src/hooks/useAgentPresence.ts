import { useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api'
import { startTicker } from '../lib/backgroundTicker'
import {
  HEARTBEAT_INTERVAL_MS,
  LEAVE_GRACE_MS,
  SWEEP_INTERVAL_MS,
} from '../lib/presenceConfig'
import { supabase } from '../lib/supabase'
import type { Agent } from '../types'

export type PresenceChannelStatus = 'connecting' | 'connected' | 'disconnected'

interface Result {
  /** Agent ids currently connected. null until the first presence sync lands. */
  connectedIds: ReadonlySet<string> | null
  /** This console's own link to Realtime. */
  channelStatus: PresenceChannelStatus
}

// supabase-js query builders are lazy: they only send the request once
// awaited (or .then'd). `void supabase.rpc(...)` would silently do nothing,
// so this must be an async function that awaits the call.
//
// Returns whether the beat landed. It's aborted after one interval so a
// black-holed network (packets dropped, fetch never fails) still registers
// as a failure instead of hanging forever.
async function heartbeat(agentId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .rpc('agent_heartbeat', { p_agent_id: agentId })
      .abortSignal(AbortSignal.timeout(HEARTBEAT_INTERVAL_MS))
    return !error
  } catch {
    return false
  }
}

/**
 * Presence for one agent console. Three jobs, all deliberately redundant
 * with each other in different failure modes:
 *
 * 1. Realtime Presence (live, instant): track this agent, observe everyone
 *    else. This drives the "Disconnected" UI the moment a peer's socket
 *    closes.
 * 2. A durable heartbeat (every few seconds) into Postgres, because
 *    serverless functions can't hold a socket to read Presence. The server
 *    decides an agent has dropped only when this goes stale.
 * 3. Reaper triggers: when a peer leaves Presence, nudge the reaper after a
 *    short grace; independently, sweep on a timer as a backstop (covers
 *    network kills where the socket is slow to time out, and consoles that
 *    joined after the leave). The server re-checks the heartbeat itself, so
 *    these calls carry no authority — they only prompt a check.
 *
 * `channelStatus` reports this console's own connection health, combining
 * Realtime's status with heartbeat success (see the note at the bottom).
 */
export function useAgentPresence(agent: Agent): Result {
  const [connectedIds, setConnectedIds] = useState<ReadonlySet<string> | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<PresenceChannelStatus>('connecting')
  const [heartbeatFailing, setHeartbeatFailing] = useState(false)

  // Latest values for use inside long-lived callbacks without re-subscribing.
  const statusRef = useRef(agent.status)
  useEffect(() => {
    statusRef.current = agent.status
  })

  useEffect(() => {
    let cancelled = false
    const beat = async () => {
      const ok = await heartbeat(agent.id)
      if (!cancelled) setHeartbeatFailing(!ok)
    }
    void beat()
    // Worker-driven, not setInterval: a console left in a background tab is
    // still a live, working console, and Chrome throttles page timers there to
    // ~1/min — long enough for the server to declare this agent dropped and
    // move their conversations away (see lib/backgroundTicker.ts).
    const stopTicker = startTicker(HEARTBEAT_INTERVAL_MS, () => void beat())

    // The browser knows immediately when the network drops; don't wait for
    // the next beat to notice. Coming back, beat right away.
    const onOffline = () => setHeartbeatFailing(true)
    const onOnline = () => void beat()
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      stopTicker()
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [agent.id])

  useEffect(() => {
    const sweep = () => {
      postJson('/api/reap-disconnected', {}).catch(() => {})
    }
    sweep()
    // Same reason as the heartbeat: a backgrounded console is often the only
    // one left running sweeps, so it must not go quiet.
    return startTicker(SWEEP_INTERVAL_MS, sweep)
  }, [])

  useEffect(() => {
    let cancelled = false
    let previousIds = new Set<string>()
    const leaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const channel = supabase.channel('presence:agents', {
      // Keyed by agent id: an agent with two tabs open is one presence key
      // with two metas, so they only "leave" when both are gone.
      config: { presence: { key: agent.id } },
    })

    channel.on('presence', { event: 'sync' }, () => {
      const ids = new Set(Object.keys(channel.presenceState()))

      for (const id of previousIds) {
        if (ids.has(id) || id === agent.id || leaveTimers.has(id)) continue
        // Grace period: a reload or blip re-joins within seconds, and
        // nudging for that would just be noise.
        leaveTimers.set(
          id,
          setTimeout(() => {
            leaveTimers.delete(id)
            if (!previousIds.has(id)) {
              postJson('/api/reap-disconnected', { agentId: id }).catch(() => {})
            }
          }, LEAVE_GRACE_MS),
        )
      }
      for (const id of ids) {
        const pending = leaveTimers.get(id)
        if (pending) {
          clearTimeout(pending)
          leaveTimers.delete(id)
        }
      }

      previousIds = ids
      setConnectedIds(ids)
    })

    channel.subscribe(async (status) => {
      if (cancelled) return

      if (status === 'SUBSCRIBED') {
        await channel.track({ agentId: agent.id, name: agent.name })
        if (cancelled) return
        setRealtimeStatus('connected')

        // An agent who's already 'online' when they (re)connect should be
        // handed queued work, same as if they'd just clicked online. Stamp
        // a heartbeat first: the server only routes to agents it can see
        // are connected.
        if (statusRef.current === 'online') {
          await heartbeat(agent.id)
          postJson('/api/agent-online', { agentId: agent.id }).catch(() => {})
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setRealtimeStatus('disconnected')
      }
    })

    return () => {
      cancelled = true
      for (const timer of leaveTimers.values()) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [agent.id, agent.name])

  // Realtime alone is slow to notice a silently dead socket (its own
  // heartbeat cycle is ~25s) — longer than the 15s after which the server
  // reassigns our conversations. A failing durable heartbeat is the same
  // signal the server acts on, so surface it too: the agent hears "connection
  // lost" *before* their conversations move, not after.
  const channelStatus: PresenceChannelStatus =
    realtimeStatus === 'disconnected' || heartbeatFailing ? 'disconnected' : realtimeStatus

  return { connectedIds, channelStatus }
}
