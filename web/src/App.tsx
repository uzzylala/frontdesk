import { AgentConsolePage } from './pages/AgentConsolePage'
import { CustomerChatPage } from './pages/CustomerChatPage'

// No router yet — phase 1 only has two static entry points. A real router
// lands when the console grows beyond a single page (phase 2+).
function App() {
  const isAgentConsole = window.location.pathname.startsWith('/agent')
  return isAgentConsole ? <AgentConsolePage /> : <CustomerChatPage />
}

export default App
