/**
 * Everything needed to make Tailwind's output behave inside a shadow root.
 * The shadow boundary stops *selectors* crossing in either direction, but
 * Tailwind v4 and CSS inheritance each have a way of sneaking past it.
 */

/**
 * Rules for the custom element itself and the widget's inner root.
 *
 * - The host element lives in the *host page's* cascade, so a page rule like
 *   `* { padding: 20px; border: 1px solid red }` would hit it. In the
 *   cascade, `!important` declarations from an inner shadow context beat
 *   outer ones, so `!important` here makes the host element immune. It's a
 *   zero-size fixed anchor, so it can't take up space in the page's layout.
 * - Inherited properties (font-family, color, line-height, ...) flow through
 *   the shadow boundary from the host element. `all: initial` on the inner
 *   root cuts that off, then we set our own base values explicitly.
 */
export const HOST_CSS = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  z-index: 2147483647 !important;
}
.fd-root {
  all: initial;
  display: block;
  position: fixed;
  right: 20px;
  bottom: 20px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: #0f172a;
  text-align: left;
  -webkit-text-size-adjust: 100%;
}
`

const round = (n: number) => Number(n.toFixed(4))

/**
 * Adapts compiled Tailwind v4 CSS for use inside a shadow root:
 *
 * 1. `@property` at-rules are ignored inside shadow trees. Tailwind v4
 *    relies on them to give its `--tw-*` variables initial values, so
 *    without this `border` loses its style, and shadows/transforms/rings
 *    silently vanish. We hoist each initial-value into a `:host` custom
 *    property default instead (custom properties inherit into the tree).
 * 2. `rem` resolves against the *host page's* `<html>` font-size, so a page
 *    with `html { font-size: 28px }` would rescale the widget — host CSS
 *    leaking in. Convert to px (Tailwind's 1rem = 16px).
 */
export function prepareShadowCss(css: string): string {
  const defaults: string[] = []

  const withoutProperties = css.replace(
    /@property\s+(--[\w-]+)\s*\{([^}]*)\}/g,
    (_match, name: string, body: string) => {
      const initial = /initial-value\s*:\s*([^;}]+)/.exec(body)
      if (initial) defaults.push(`${name}:${initial[1].trim()}`)
      return ''
    },
  )

  const withPx = withoutProperties.replace(
    /(-?\d*\.?\d+)rem\b/g,
    (_match, n: string) => `${round(parseFloat(n) * 16)}px`,
  )

  return `:host{${defaults.join(';')}}\n${withPx}`
}
