import { createRoot, type Root } from 'react-dom/client'
import widgetCss from './widget.css?inline'
import { HOST_CSS, prepareShadowCss } from './shadowCss'
import { Widget } from './Widget'

// Must be read synchronously, while this script is executing.
const script = document.currentScript as HTMLScriptElement | null

const TAG = 'frontdesk-widget'

class FrontdeskWidgetElement extends HTMLElement {
  #root: Root | null = null

  connectedCallback() {
    if (this.shadowRoot) return

    // Open, not closed: closed adds almost no real protection (host JS can
    // still reach the light-DOM element) and makes devtools and tests harder.
    const shadow = this.attachShadow({ mode: 'open' })

    // Styles live *inside* the shadow root — nothing is added to the host
    // document's <head> or stylesheets.
    const style = document.createElement('style')
    style.textContent = HOST_CSS + prepareShadowCss(widgetCss)

    const mountPoint = document.createElement('div')
    mountPoint.className = 'fd-root'
    shadow.append(style, mountPoint)

    this.#root = createRoot(mountPoint)
    this.#root.render(
      <Widget
        apiBase={this.getAttribute('data-api-url') ?? ''}
        customerName={this.getAttribute('data-customer-name') ?? undefined}
      />,
    )
  }

  disconnectedCallback() {
    this.#root?.unmount()
    this.#root = null
  }
}

function mountWidget() {
  if (document.querySelector(TAG)) return // already embedded

  if (!customElements.get(TAG)) customElements.define(TAG, FrontdeskWidgetElement)

  const el = document.createElement(TAG)
  // API calls go back to wherever the script was served from, unless the
  // embedder points them elsewhere with data-api-url.
  const apiUrl = script?.dataset.apiUrl ?? (script?.src ? new URL(script.src).origin : '')
  el.setAttribute('data-api-url', apiUrl)
  if (script?.dataset.customerName) {
    el.setAttribute('data-customer-name', script.dataset.customerName)
  }
  document.body.appendChild(el)
}

if (document.body) mountWidget()
else document.addEventListener('DOMContentLoaded', mountWidget, { once: true })
