import { useEffect, useRef, useState } from "react";
import { AgentRoster } from "../components/AgentRoster";
import { AgentStatusToggle } from "../components/AgentStatusToggle";
import { ChatWindow } from "../components/ChatWindow";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { LiveRegion } from "../components/LiveRegion";
import { QueueList } from "../components/QueueList";
import { useAgentPresence } from "../hooks/useAgentPresence";
import { useAgentRoster } from "../hooks/useAgentRoster";
import { useConsoleAnnouncements } from "../hooks/useConsoleAnnouncements";
import { useConsoleChannels } from "../hooks/useConsoleChannels";
import { useCurrentAgent } from "../hooks/useCurrentAgent";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { expectSelfClaim, forgetSelfClaim } from "../lib/consoleEvents";
import { supabase } from "../lib/supabase";
import { useConsoleStore } from "../store/consoleStore";

export function AgentConsolePage() {
  const {
    agents,
    currentAgent,
    loading,
    error,
    selectAgent,
    switchAgent,
    setStatus,
  } = useCurrentAgent();

  // Choosing or switching agent swaps the whole view, which unmounts the button
  // that had focus and drops it onto <body>. When the *user* caused that swap,
  // put focus on the new view's heading so a keyboard or screen-reader user
  // lands somewhere meaningful. Not done on first load, where it would skip the
  // skip links.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const userNavigated = useRef(false);
  useEffect(() => {
    if (userNavigated.current) {
      headingRef.current?.focus();
      userNavigated.current = false;
    }
  }, [currentAgent?.id]);

  useDocumentTitle(
    currentAgent
      ? `${currentAgent.name} — Frontdesk agent console`
      : "Frontdesk agent console",
  );

  if (loading)
    return (
      <p role="status" className="p-4 text-sm text-slate-600">
        Loading…
      </p>
    );
  if (error)
    return (
      <p role="alert" className="p-4 text-sm text-red-700">
        Couldn't load agents: {error}
      </p>
    );

  if (!currentAgent) {
    return (
      <main className="mx-auto max-w-sm p-6">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mb-1 text-sm font-semibold text-slate-900"
        >
          Who are you?
        </h1>
        <p className="mb-4 text-xs text-slate-600">
          No login yet — pick an agent to continue.
        </p>
        <div className="space-y-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                userNavigated.current = true;
                selectAgent(agent.id);
              }}
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
            >
              {agent.name}
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <ConsoleBody
      agents={agents}
      currentAgent={currentAgent}
      switchAgent={() => {
        userNavigated.current = true;
        switchAgent();
      }}
      headingRef={headingRef}
      setStatus={setStatus}
    />
  );
}

interface ConsoleBodyProps {
  agents: ReturnType<typeof useCurrentAgent>["agents"];
  currentAgent: NonNullable<ReturnType<typeof useCurrentAgent>["currentAgent"]>;
  switchAgent: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  setStatus: ReturnType<typeof useCurrentAgent>["setStatus"];
}

function ConsoleBody({
  agents,
  currentAgent,
  switchAgent,
  headingRef,
  setStatus,
}: ConsoleBodyProps) {
  const { queue, loading, error } = useAgentRoster(currentAgent.id);
  const { connectedIds, channelStatus } = useAgentPresence(currentAgent);
  const agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]));

  const order = useConsoleStore((s) => s.order);
  const conversations = useConsoleStore((s) => s.conversations);
  const activeId = useConsoleStore((s) => s.activeConversationId);
  const setActiveConversation = useConsoleStore((s) => s.setActiveConversation);
  const setDraft = useConsoleStore((s) => s.setDraft);

  useConsoleChannels(order);
  useConsoleAnnouncements({
    agents,
    selfId: currentAgent.id,
    connectedIds,
    queueCount: loading ? null : queue.length,
  });

  // --- keyboard focus management ---
  // The message box of every conversation stays mounted (hidden panels keep
  // their scroll position), so each registers itself here by conversation id.
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const [focusRequest, setFocusRequest] = useState<{
    id: string;
    n: number;
  } | null>(null);
  const [claimedId, setClaimedId] = useState<string | null>(null);

  // Focusing has to wait for the commit that un-hides the panel — a hidden
  // input can't take focus — so it's an effect on the request, not a call
  // made from the click handler.
  useEffect(() => {
    if (!focusRequest || activeId !== focusRequest.id) return;
    inputRefs.current.get(focusRequest.id)?.focus();
  }, [focusRequest, activeId]);

  function openConversation(id: string) {
    setActiveConversation(id);
    setFocusRequest({ id, n: Date.now() });
  }

  function focusConversationButton(id: string) {
    document
      .querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)
      ?.focus();
  }

  // After claiming from the queue the conversation reaches the store via
  // Realtime a moment later; open it (and its message box) once it has.
  useEffect(() => {
    if (claimedId && order.includes(claimedId)) {
      openConversation(claimedId);
      setClaimedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimedId, order]);

  async function pickUp(conversationId: string): Promise<boolean> {
    // So the "assigned to you" announcement skips the person who just asked.
    expectSelfClaim(conversationId);
    const { data, error } = await supabase
      .from("conversations")
      .update({ assigned_agent_id: currentAgent.id })
      .eq("id", conversationId)
      .is("assigned_agent_id", null)
      .select();

    if (error) {
      console.error("Failed to pick up conversation", error);
      forgetSelfClaim(conversationId);
      return false;
    }
    if (!data || data.length === 0) {
      forgetSelfClaim(conversationId);
      return false;
    }

    setClaimedId(conversationId);

    // Best-effort tie-break bookkeeping — not critical if this fails.
    supabase
      .from("agents")
      .update({ last_assigned_at: new Date().toISOString() })
      .eq("id", currentAgent.id)
      .then(() => {});

    return true;
  }

  return (
    <div className="flex h-screen">
      <div className="relative flex w-full max-w-5xl flex-col border-x border-slate-200">
        {order.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => activeId && focusConversationButton(activeId)}
              className={SKIP_LINK}
            >
              Skip to conversations
            </button>
            <button
              type="button"
              onClick={() =>
                activeId && setFocusRequest({ id: activeId, n: Date.now() })
              }
              className={SKIP_LINK}
            >
              Skip to message box
            </button>
          </>
        )}
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-semibold text-slate-900"
            >
              {currentAgent.name}
            </h1>
            <button
              type="button"
              onClick={switchAgent}
              className="text-xs text-slate-600 underline"
            >
              Switch agent
            </button>
          </div>
          <AgentStatusToggle
            status={currentAgent.status}
            onChange={setStatus}
          />
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
        {channelStatus === "disconnected" && (
          <p role="status" className="bg-red-50 px-4 py-2 text-xs text-red-800">
            Connection lost — reconnecting. Your conversations may be reassigned
            to another agent if this lasts more than a few seconds.
          </p>
        )}

        <AgentRoster
          agents={agents}
          connectedIds={connectedIds}
          selfId={currentAgent.id}
        />

        <QueueList queue={queue} agentNames={agentNames} onPickUp={pickUp} />

        <div className="flex min-h-0 flex-1 md:flex-row">
          {loading ? (
            <p role="status" className="p-4 text-sm text-slate-600">
              Loading conversations…
            </p>
          ) : error ? (
            <p role="alert" className="p-4 text-sm text-red-700">
              Couldn't load conversations: {error}
            </p>
          ) : order.length === 0 ? (
            <p className="p-4 text-sm text-slate-600">
              No conversations assigned to you yet.
              {queue.length > 0 &&
                " Pick one up from the queue above, or go online to get routed the next one automatically."}
            </p>
          ) : (
            <>
              <ConversationSidebar
                agentNames={agentNames}
                order={order}
                conversations={conversations}
                activeId={activeId}
                onSelect={openConversation}
              />
              <div className="relative min-h-0 flex-1">
                {order.map((id) => {
                  const entry = conversations[id];
                  if (!entry) return null;
                  return (
                    <div
                      key={id}
                      className={id === activeId ? "h-full" : "hidden"}
                    >
                      <ChatWindow
                        conversationId={id}
                        role="agent"
                        counterpart={entry.customerName}
                        inputRef={(el) => {
                          if (el) inputRefs.current.set(id, el);
                          else inputRefs.current.delete(id);
                        }}
                        onEscape={() => focusConversationButton(id)}
                        messages={entry.messages}
                        messagesLoading={entry.messagesLoading}
                        connectionStatus={entry.connectionStatus}
                        draft={entry.draft}
                        onDraftChange={(draft) => setDraft(id, draft)}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        </main>
      </div>
      <LiveRegion />
    </div>
  );
}

// Visually hidden until keyboard focus lands on it, then shown top-left.
const SKIP_LINK =
  "sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-indigo-800 focus:shadow-lg";
