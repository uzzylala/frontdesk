import type { ConversationEntry } from '../store/consoleStore'

/**
 * The accessible name of a conversation-list item: everything a sighted agent
 * gets from the row at a glance (who, how many unread, whether it was
 * transferred, whether its connection is failing, the last message), as one
 * sentence-like string. The unread badge is a coloured pill visually; this is
 * what makes it *announced* rather than just shown.
 */
export function describeConversation(
  entry: Pick<
    ConversationEntry,
    'customerName' | 'unreadCount' | 'previousAgentId' | 'connectionStatus' | 'messagesLoading' | 'messages'
  >,
  agentNames: Record<string, string>,
): string {
  const parts = [entry.customerName]

  if (entry.unreadCount > 0) {
    parts.push(`${entry.unreadCount} unread ${entry.unreadCount === 1 ? 'message' : 'messages'}`)
  }
  if (entry.previousAgentId) {
    parts.push(`transferred from ${agentNames[entry.previousAgentId] ?? 'another agent'}`)
  }
  if (entry.connectionStatus === 'error') parts.push('connection issue')

  const last = entry.messages[entry.messages.length - 1]
  parts.push(entry.messagesLoading ? 'loading' : last ? `last message: ${last.body}` : 'no messages yet')

  return parts.join(', ')
}
