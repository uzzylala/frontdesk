import { useEffect, useRef } from 'react'
import { AGENT_STATE_LABEL, effectiveAgentState } from '../lib/agentState'
import { createBatcher, type Batcher } from '../lib/announcementBatcher'
import { onConsoleEvent } from '../lib/consoleEvents'
import { formatConsoleAnnouncements, type ConsoleAnnouncement } from '../lib/formatAnnouncements'
import { announce } from '../store/announcerStore'
import type { Agent } from '../types'

interface Options {
  agents: Agent[]
  selfId: string
  /** null until the first presence sync. */
  connectedIds: ReadonlySet<string> | null
  /** null until the queue has been fetched. */
  queueCount: number | null
}

/**
 * Turns what happens in the console into spoken, polite, batched
 * announcements for screen-reader users. Three sources:
 *  - live events from the data layer (a customer message arrived; a
 *    conversation was assigned to you),
 *  - the queue length changing,
 *  - another agent's effective state changing (came online, dropped, ...).
 * The last two are found by diffing, and the first observation of each is
 * only recorded, never announced: opening the console must not read out
 * the current state as if it were news.
 */
export function useConsoleAnnouncements({ agents, selfId, connectedIds, queueCount }: Options) {
  const batcherRef = useRef<Batcher<ConsoleAnnouncement> | null>(null)
  const namesRef = useRef<Record<string, string>>({})
  useEffect(() => {
    namesRef.current = Object.fromEntries(agents.map((a) => [a.id, a.name]))
  })

  useEffect(() => {
    const batcher = createBatcher<ConsoleAnnouncement>({
      onFlush: (items) => announce(formatConsoleAnnouncements(items)),
    })
    batcherRef.current = batcher

    const stopListening = onConsoleEvent((event) => {
      if (event.type === 'message') {
        batcher.push({ kind: 'message', conversationId: event.conversationId, customerName: event.customerName })
      } else {
        batcher.push({
          kind: 'assigned',
          customerName: event.customerName,
          previousAgentName: event.previousAgentId
            ? (namesRef.current[event.previousAgentId] ?? 'another agent')
            : null,
        })
      }
    })

    return () => {
      stopListening()
      batcher.dispose()
      batcherRef.current = null
    }
  }, [])

  const previousQueue = useRef<number | null>(null)
  useEffect(() => {
    if (queueCount === null) return
    if (previousQueue.current !== null && previousQueue.current !== queueCount) {
      batcherRef.current?.push({ kind: 'queue', count: queueCount })
    }
    previousQueue.current = queueCount
  }, [queueCount])

  const previousStates = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (connectedIds === null) return
    const states = new Map<string, string>()
    for (const agent of agents) {
      if (agent.id === selfId) continue
      states.set(agent.id, AGENT_STATE_LABEL[effectiveAgentState(agent, connectedIds.has(agent.id))])
    }
    const previous = previousStates.current
    if (previous) {
      for (const agent of agents) {
        const label = states.get(agent.id)
        if (label && previous.has(agent.id) && previous.get(agent.id) !== label) {
          batcherRef.current?.push({ kind: 'presence', agentId: agent.id, agentName: agent.name, stateLabel: label })
        }
      }
    }
    previousStates.current = states
  }, [agents, connectedIds, selfId])
}
