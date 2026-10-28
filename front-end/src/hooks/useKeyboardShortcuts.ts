/** Keyboard shortcuts for the canvas (search shortcuts live in SearchBar). */

import { useReactFlow } from '@xyflow/react'
import { useEffect } from 'react'

import { useExplorerStore } from '../store/useExplorerStore'

export function useKeyboardShortcuts() {
  const { fitView } = useReactFlow()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const store = useExplorerStore.getState()

      switch (event.key.toLowerCase()) {
        case 'f':
          event.preventDefault()
          store.cycleFocusMode()
          break
        case 'z':
          event.preventDefault()
          fitView({ duration: 600, padding: 0.18 })
          break
        case 'm':
          event.preventDefault()
          store.toggleMiniMap()
          break
        case 'l':
          event.preventDefault()
          store.setLayoutMode(store.layoutMode === 'dag' ? 'lanes' : 'dag')
          break
        case 'e':
          event.preventDefault()
          store.expandSelectionLineage()
          break
        case 'escape':
          event.preventDefault()
          if (store.activeId) store.closeOverlay()
          else store.clearSelection()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitView])
}
