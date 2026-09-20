import { useEffect } from 'react'

/** Each page needs its own title: it's the first thing a screen reader says on load and what a tab shows. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}
