/**
 * What gets said, kept separate from when (announcementBatcher.ts) and where
 * (the live region), so the wording is a pure function that can be tested.
 */

export type ConsoleAnnouncement =
  | { kind: 'message'; conversationId: string; customerName: string }
  | { kind: 'assigned'; customerName: string; previousAgentName: string | null }
  | { kind: 'presence'; agentId: string; agentName: string; stateLabel: string }
  | { kind: 'queue'; count: number }

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** End a sentence, without doubling the full stop of a name that already has one ("Sam K."). */
const sentence = (text: string) => (text.endsWith('.') ? text : `${text}.`)

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * One sentence group for a whole batch. Most actionable first: conversations
 * handed to you, then new messages, then the queue, then who else came or went.
 * Repeated facts collapse: only an agent's latest state and the latest queue
 * size are reported, and messages are counted per conversation.
 */
export function formatConsoleAnnouncements(items: ConsoleAnnouncement[]): string {
  const parts: string[] = []

  const assigned = items.filter((i) => i.kind === 'assigned')
  if (assigned.length === 1) {
    const { customerName, previousAgentName } = assigned[0]
    parts.push(
      previousAgentName
        ? sentence(`Conversation with ${customerName} reassigned to you from ${previousAgentName}`)
        : sentence(`Conversation with ${customerName} assigned to you`),
    )
  } else if (assigned.length > 1) {
    parts.push(
      sentence(`${assigned.length} conversations assigned to you: ${joinNames(assigned.map((a) => a.customerName))}`),
    )
  }

  const perConversation = new Map<string, { name: string; count: number }>()
  for (const item of items) {
    if (item.kind !== 'message') continue
    const entry = perConversation.get(item.conversationId)
    if (entry) entry.count++
    else perConversation.set(item.conversationId, { name: item.customerName, count: 1 })
  }
  const groups = [...perConversation.values()]
  const totalMessages = groups.reduce((sum, g) => sum + g.count, 0)
  if (groups.length === 1) {
    const [g] = groups
    parts.push(
      sentence(g.count === 1 ? `New message from ${g.name}` : `${g.count} new messages from ${g.name}`),
    )
  } else if (groups.length > 1 && groups.length <= 3) {
    parts.push(
      sentence(`${totalMessages} new messages: ${joinNames(groups.map((g) => `${g.count} from ${g.name}`))}`),
    )
  } else if (groups.length > 3) {
    parts.push(`${totalMessages} new messages across ${groups.length} conversations.`)
  }

  const queue = items.filter((i) => i.kind === 'queue').at(-1)
  if (queue) {
    parts.push(
      queue.count === 0
        ? 'Queue is now empty.'
        : `${queue.count} ${plural(queue.count, 'conversation', 'conversations')} waiting in the queue.`,
    )
  }

  const latestState = new Map<string, { name: string; label: string }>()
  for (const item of items) {
    if (item.kind === 'presence') latestState.set(item.agentId, { name: item.agentName, label: item.stateLabel })
  }
  for (const { name, label } of latestState.values()) parts.push(`${name} is now ${label}.`)

  return parts.join(' ')
}

/** Customer-side: what a customer (or widget visitor) hears when support replies. */
export function formatSupportReplies(bodies: string[]): string {
  const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}…` : text)
  if (bodies.length === 0) return ''
  if (bodies.length === 1) return `Support: ${clip(bodies[0])}`
  return `${bodies.length} new messages from support. Latest: ${clip(bodies[bodies.length - 1])}`
}
