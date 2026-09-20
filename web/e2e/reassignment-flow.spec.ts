import { expect, test, type Page } from '@playwright/test'
// The verification suites' shared helpers: agent lookup, and a cleanup that only ever touches seed/test data.
// @ts-expect-error - plain ESM JavaScript, no type declarations
import { admin, agents, cleanup } from '../verify/lib.mjs'

/**
 * The whole product in one flow, the way a customer and two agents would live it:
 *
 *   a customer starts a chat → it is routed to an online agent → that agent replies and the customer sees it →
 *   that agent's connection dies → after the heartbeat goes stale the conversation is reassigned to the other
 *   online agent (who is told) → the new agent replies → the customer sees both replies, in order, in one thread.
 *
 * It runs against the real app and the real Supabase project (there is no separate test database on the free
 * tier), so it uses only the two demo agents, names nothing after a real person, and removes what it creates.
 */

const AGENT_A = 'Jordan P.'
const AGENT_B = 'Sam K.'
const customerMessage = `E2E hello from a customer ${Date.now()}`
const firstReply = 'E2E first agent here, happy to help'
const secondReply = 'E2E second agent here, I have taken over'

async function signIn(page: Page, name: string) {
  await page.goto('/agent')
  await page.getByRole('button', { name }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  // Wait for the console to finish loading before anything depends on it.
  await expect(page.getByRole('radio', { name: 'away' })).toBeChecked()
}
const goOnline = async (page: Page) => {
  await page.getByRole('radio', { name: 'online' }).check({ force: true })
  await expect(page.getByRole('radio', { name: 'online' })).toBeChecked()
}
const conversationButton = (page: Page, id: string) => page.locator(`[data-conversation-id="${id}"]`)
const messageBox = (page: Page) => page.locator('form[aria-label="Send a message"]:visible input')

test('customer chats, the agent replies, the agent drops, the other agent takes over and replies', async ({ browser }) => {
  await cleanup() // known starting state: both agents away, no stale heartbeats, seed data restored
  const ids: string[] = []
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const [ctxA, ctxB, ctxCustomer] = contexts

  try {
    // --- two agents online -------------------------------------------------------------------------------------
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    await signIn(pageA, AGENT_A)
    await signIn(pageB, AGENT_B)
    await goOnline(pageA)
    await goOnline(pageB)
    const id = await agents()
    await expect
      .poll(async () => (await admin.from('agent_heartbeats').select('agent_id').in('agent_id', [id[AGENT_A], id[AGENT_B]])).data?.length, { message: 'both consoles are heartbeating' })
      .toBe(2)

    // --- a customer starts a chat ----------------------------------------------------------------------------------
    const customer = await ctxCustomer.newPage()
    await customer.goto('/')
    await customer.getByPlaceholder('Type a message…').fill(customerMessage)
    await customer.keyboard.press('Enter')
    await expect(customer.getByRole('log').getByText(customerMessage)).toBeVisible()
    const conversationId = await customer.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)))
    expect(conversationId, 'the customer page remembers its conversation').toBeTruthy()
    ids.push(conversationId as string)

    // --- it is routed to exactly one of the two online agents ------------------------------------------------------
    await expect
      .poll(async () => (await conversationButton(pageA, conversationId as string).count()) + (await conversationButton(pageB, conversationId as string).count()), {
        message: 'the conversation shows up for one agent',
        timeout: 30_000,
      })
      .toBe(1)
    const aGotIt = (await conversationButton(pageA, conversationId as string).count()) === 1
    const [first, second, firstName, secondName] = aGotIt ? [pageA, pageB, AGENT_A, AGENT_B] : [pageB, pageA, AGENT_B, AGENT_A]
    const firstContext = aGotIt ? ctxA : ctxB
    await expect(conversationButton(second, conversationId as string)).toHaveCount(0) // and the other agent does not have it

    // --- the first agent replies; the customer sees it live -----------------------------------------------------
    await conversationButton(first, conversationId as string).click()
    await expect(first.getByRole('log').getByText(customerMessage)).toBeVisible()
    await messageBox(first).fill(firstReply)
    await first.keyboard.press('Enter')
    await expect(customer.getByRole('log').getByText(firstReply)).toBeVisible()

    // --- the first agent's connection dies (the tab is gone; nothing tells the server) -------------------------------
    await firstContext.close()

    // --- after the heartbeat goes stale the conversation moves to the other agent, who is told ---------------------
    await expect(conversationButton(second, conversationId as string), `${secondName} is handed the conversation`).toBeVisible({ timeout: 90_000 })
    await expect(second.getByRole('status').filter({ hasText: /reassigned to you/ })).toContainText(`from ${firstName}`)
    const moved = await admin.from('conversations').select('*').eq('id', conversationId).single()
    expect(moved.data.assigned_agent_id).toBe(id[secondName])
    expect(moved.data.previous_agent_id, 'the audit trail names who it came from').toBe(id[firstName])
    // Only once supabase/assigned-via.sql has been applied (the app works either way): the reaper tags what it did.
    if ('assigned_via' in moved.data) expect(moved.data.assigned_via).toBe('reassignment')

    // --- the new agent picks it up and replies; the customer sees one unbroken thread -----------------------------
    await conversationButton(second, conversationId as string).click()
    await expect(second.getByRole('log').getByText(firstReply)).toBeVisible() // the history came with it
    await messageBox(second).fill(secondReply)
    await second.keyboard.press('Enter')
    await expect(customer.getByRole('log').getByText(secondReply)).toBeVisible()

    const transcript = await customer.getByRole('log').innerText()
    const at = (s: string) => transcript.indexOf(s)
    expect(at(customerMessage)).toBeGreaterThanOrEqual(0)
    expect(at(customerMessage)).toBeLessThan(at(firstReply))
    expect(at(firstReply)).toBeLessThan(at(secondReply))
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})))
    await cleanup(ids)
  }
})
