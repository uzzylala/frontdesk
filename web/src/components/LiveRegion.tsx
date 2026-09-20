import { useAnnouncerStore } from '../store/announcerStore'

/**
 * The page's one polite, atomic live region. It must be mounted before it has
 * anything to say — screen readers only watch regions that already exist — and
 * it must not be inside anything `display: none` (which is why the console's
 * hidden conversation panels can't host their own).
 */
export function LiveRegion() {
  const text = useAnnouncerStore((s) => s.text)
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  )
}
