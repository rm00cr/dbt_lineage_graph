/**
 * html-to-image inlines *every* computed CSS property (~400) on every element of an SVG
 * export, which makes it ~10 KB per element (a 32-node graph: 9 MB). This drops what
 * does not change the picture:
 *
 *   1. CSS custom properties (`--theme-vars`): every value is already resolved
 *   2. properties equal to the browser default for that element type
 *   3. inherited properties (fonts, colours, ...) equal to the parent's value
 *   4. colours that default to `currentColor` (borders, outline, ...) equal to `color`
 *
 * Defaults are measured in a hidden iframe (no page styles), per element type.
 */

// properties that inherit in CSS; repeating the parent's value is redundant for these
const INHERITED = new Set([
  'color',
  'cursor',
  'direction',
  'fill',
  'fill-opacity',
  'fill-rule',
  'font',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-weight',
  '-webkit-font-smoothing',
  'letter-spacing',
  'line-height',
  'list-style',
  'paint-order',
  'pointer-events',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'tab-size',
  'text-align',
  'text-anchor',
  'text-indent',
  'text-rendering',
  'text-shadow',
  'text-transform',
  'visibility',
  'white-space',
  'word-break',
  'word-spacing',
  'overflow-wrap',
  'writing-mode',
])

// properties whose initial value is `currentColor`
const CURRENT_COLOR = new Set([
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-block-start-color',
  'border-block-end-color',
  'border-inline-start-color',
  'border-inline-end-color',
  'outline-color',
  'text-decoration-color',
  'text-emphasis-color',
  'column-rule-color',
  'caret-color',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
])

const SVG_NS = 'http://www.w3.org/2000/svg'

class DefaultStyles {
  private frame: HTMLIFrameElement
  private cache = new Map<string, Map<string, string>>()

  constructor() {
    this.frame = document.createElement('iframe')
    this.frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
    document.body.appendChild(this.frame)
  }

  get(element: Element): Map<string, string> {
    const key = `${element.namespaceURI}|${element.localName}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const doc = this.frame.contentDocument!
    const probe =
      element.namespaceURI === SVG_NS
        ? doc.createElementNS(SVG_NS, element.localName)
        : doc.createElement(element.localName)
    const host = element.namespaceURI === SVG_NS ? doc.createElementNS(SVG_NS, 'svg') : doc.body
    if (host !== doc.body) doc.body.appendChild(host)
    host.appendChild(probe)
    const computed = this.frame.contentWindow!.getComputedStyle(probe)
    const values = new Map<string, string>()
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i]
      values.set(name, computed.getPropertyValue(name))
    }
    probe.remove()
    if (host !== doc.body) host.remove()
    this.cache.set(key, values)
    return values
  }

  dispose() {
    this.frame.remove()
  }
}

function slimElement(
  element: Element,
  defaults: DefaultStyles,
  inherited: Map<string, string>,
): void {
  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined
  // what this element's children inherit: the parent's values, overridden by our own
  const effective = new Map(inherited)

  if (style && style.length > 0) {
    const base = defaults.get(element)
    const color = style.getPropertyValue('color')
    const keep: string[] = []
    for (let i = 0; i < style.length; i++) {
      const name = style[i]
      if (name.startsWith('--')) continue
      const value = style.getPropertyValue(name)
      if (CURRENT_COLOR.has(name) && value === color) continue
      const isInherited = INHERITED.has(name)
      const expected = isInherited && inherited.has(name) ? inherited.get(name) : base.get(name)
      if (isInherited) effective.set(name, value)
      if (value === expected) continue
      keep.push(`${name}:${value}`)
    }
    if (keep.length) element.setAttribute('style', keep.join(';'))
    else element.removeAttribute('style')
  }

  for (const child of element.children) slimElement(child, defaults, effective)
}

/** Slim an SVG data URL as returned by html-to-image's `toSvg`. */
export function slimSvgDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const svg = decodeURIComponent(dataUrl.slice(comma + 1))
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return dataUrl // keep the original

  const defaults = new DefaultStyles()
  try {
    slimElement(doc.documentElement, defaults, new Map())
  } finally {
    defaults.dispose()
  }
  const slim = new XMLSerializer().serializeToString(doc)
  return `${dataUrl.slice(0, comma + 1)}${encodeURIComponent(slim)}`
}
