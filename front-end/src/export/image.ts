/**
 * Render the lineage canvas to a PNG or SVG image (html-to-image, as recommended by React
 * Flow). The whole visible graph is drawn at zoom 1, not just the part in the viewport.
 */

import { toPng, toSvg } from 'html-to-image'

import { slimSvgDataUrl } from './slimSvg'

export type ImageFormat = 'png' | 'svg'

const PADDING = 48
/** browsers refuse canvases much larger than this per side */
const MAX_PNG_SIDE = 16000

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Bounds of everything drawn on the canvas (nodes incl. their change rings, zone bands), in
 * flow coordinates. Measured from the DOM, so it is right for every layout.
 */
export function contentBounds(viewportEl: HTMLElement, zoom: number): Bounds | null {
  const origin = viewportEl.getBoundingClientRect() // transform-origin 0 0: = translate offset
  const elements = viewportEl.querySelectorAll<HTMLElement>('.react-flow__node, .react-flow__viewport-portal > *')
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const element of elements) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (!Number.isFinite(left)) return null
  return {
    x: (left - origin.left) / zoom - PADDING,
    y: (top - origin.top) / zoom - PADDING,
    width: (right - left) / zoom + 2 * PADDING,
    height: (bottom - top) / zoom + 2 * PADDING,
  }
}

/** Data URL of the canvas content as an image. */
export async function renderCanvasImage(
  format: ImageFormat,
  viewportEl: HTMLElement,
  zoom: number,
  background: string,
): Promise<string> {
  const bounds = contentBounds(viewportEl, zoom)
  if (!bounds) throw new Error('Nothing to export: the canvas is empty.')
  const width = Math.ceil(bounds.width)
  const height = Math.ceil(bounds.height)
  const options = {
    width,
    height,
    backgroundColor: background,
    // system fonts only; fetching web fonts would fail on cross-origin stylesheets
    skipFonts: true,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${-bounds.x}px, ${-bounds.y}px) scale(1)`,
    },
  }
  // strip the ~400 inlined default / repeated CSS properties per element (~95% of the file)
  if (format === 'svg') return slimSvgDataUrl(await toSvg(viewportEl, options))
  // crisp on high-DPI screens and slides, but never larger than a browser canvas allows
  const pixelRatio = Math.max(0.25, Math.min(2, MAX_PNG_SIDE / Math.max(width, height)))
  return toPng(viewportEl, { ...options, pixelRatio })
}

export function downloadUrl(filename: string, href: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  downloadUrl(filename, url)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** wait until React has re-rendered and the browser has painted */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
