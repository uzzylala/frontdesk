import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBatcher } from '../../src/lib/announcementBatcher'
import { formatConsoleAnnouncements, formatSupportReplies, type ConsoleAnnouncement } from '../../src/lib/formatAnnouncements'

const msg = (conversationId: string, customerName: string): ConsoleAnnouncement => ({ kind: 'message', conversationId, customerName })

describe('formatConsoleAnnouncements', () => {
  it('says nothing for nothing', () => {
    expect(formatConsoleAnnouncements([])).toBe('')
  })

  it('names a single message’s sender, and counts a burst from one customer', () => {
    expect(formatConsoleAnnouncements([msg('1', 'Amara O.')])).toBe('New message from Amara O.')
    expect(formatConsoleAnnouncements([msg('1', 'Amara O.'), msg('1', 'Amara O.'), msg('1', 'Amara O.')])).toBe('3 new messages from Amara O.')
  })

  it('breaks a burst down per customer, up to three, then summarises', () => {
    const burst = [...Array(8).fill(0).map(() => msg('1', 'Amara O.')), ...Array(4).fill(0).map(() => msg('2', 'Deji K.'))]
    expect(formatConsoleAnnouncements(burst)).toBe('12 new messages: 8 from Amara O. and 4 from Deji K.')
    const many = ['a', 'b', 'c', 'd'].map((id) => msg(id, id))
    expect(formatConsoleAnnouncements(many)).toBe('4 new messages across 4 conversations.')
  })

  it('announces conversations handed to you first, with who they came from', () => {
    expect(formatConsoleAnnouncements([{ kind: 'assigned', customerName: 'Tom W.', previousAgentName: 'Sam K.' }, msg('1', 'Amara O.')])).toBe(
      'Conversation with Tom W. reassigned to you from Sam K. New message from Amara O.',
    )
    expect(formatConsoleAnnouncements([{ kind: 'assigned', customerName: 'Tom W.', previousAgentName: null }])).toBe('Conversation with Tom W. assigned to you.')
    expect(
      formatConsoleAnnouncements([
        { kind: 'assigned', customerName: 'A', previousAgentName: null },
        { kind: 'assigned', customerName: 'B', previousAgentName: null },
      ]),
    ).toBe('2 conversations assigned to you: A and B.')
  })

  it('does not double the full stop of a name that already ends in one ("Sam K.")', () => {
    const text = formatConsoleAnnouncements([{ kind: 'assigned', customerName: 'Tom W.', previousAgentName: 'Sam K.' }, { kind: 'queue', count: 0 }])
    expect(text).toBe('Conversation with Tom W. reassigned to you from Sam K. Queue is now empty.')
    expect(text).not.toContain('..')
  })

  it('reports only the latest queue size and each agent’s latest state', () => {
    const items: ConsoleAnnouncement[] = [
      { kind: 'queue', count: 3 },
      { kind: 'queue', count: 1 },
      { kind: 'presence', agentId: 'j', agentName: 'Jordan P.', stateLabel: 'Busy' },
      { kind: 'presence', agentId: 'j', agentName: 'Jordan P.', stateLabel: 'Disconnected' },
    ]
    expect(formatConsoleAnnouncements(items)).toBe('1 conversation waiting in the queue. Jordan P. is now Disconnected.')
  })
})

describe('formatSupportReplies (what a customer hears)', () => {
  it('reads one reply, counts several, and clips very long ones', () => {
    expect(formatSupportReplies([])).toBe('')
    expect(formatSupportReplies(['Hi, how can I help?'])).toBe('Support: Hi, how can I help?')
    expect(formatSupportReplies(['one', 'two', 'three'])).toBe('3 new messages from support. Latest: three')
    expect(formatSupportReplies(['x'.repeat(500)]).length).toBeLessThan(215)
  })
})

describe('the announcement batcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes a burst once, after it goes quiet', () => {
    const onFlush = vi.fn()
    const b = createBatcher<number>({ quietMs: 1500, maxWaitMs: 6000, onFlush })
    for (let i = 0; i < 12; i++) {
      b.push(i)
      vi.advanceTimersByTime(200) // a message every 200ms
    }
    expect(onFlush).not.toHaveBeenCalled() // still talking
    vi.advanceTimersByTime(1500)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toHaveLength(12) // one announcement, every item in it
  })

  it('a burst that never goes quiet is still flushed at the max wait, and nothing is lost between flushes', () => {
    const onFlush = vi.fn()
    const b = createBatcher<number>({ quietMs: 1500, maxWaitMs: 6000, onFlush })
    let sent = 0
    for (let t = 0; t < 10_000; t += 500) {
      b.push(sent++)
      vi.advanceTimersByTime(500)
    }
    expect(onFlush).toHaveBeenCalled() // did not wait forever
    vi.advanceTimersByTime(2000)
    const total = onFlush.mock.calls.reduce((n, c) => n + c[0].length, 0)
    expect(total).toBe(sent) // every item accounted for
    expect(onFlush.mock.calls.length).toBeLessThanOrEqual(3) // a couple of announcements, not one per item
  })

  it('flush() sends immediately, is a no-op when empty, and dispose() drops what is pending', () => {
    const onFlush = vi.fn()
    const b = createBatcher<string>({ onFlush })
    b.flush()
    expect(onFlush).not.toHaveBeenCalled()
    b.push('a')
    b.flush()
    expect(onFlush).toHaveBeenCalledWith(['a'])
    b.push('b')
    b.dispose()
    vi.advanceTimersByTime(60_000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })
})
