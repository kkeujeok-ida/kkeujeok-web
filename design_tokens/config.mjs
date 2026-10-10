// Generates build/tokens.css and build/tokens.dart from source/*.json.
// Run with `npm run tokens`. tests/contrast.test.ts imports generate() and
// loadTokens() so the committed build files and the contrast table are checked
// against the same source.
// Two snackbar action colours are literals: DESIGN.md takes them from the other
// theme (Light uses Dark's accent, Dark uses Light's accent-text).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import StyleDictionary from 'style-dictionary'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => join(here, 'source', `${name}.json`)
const outDir = join(here, 'build')

// Tokens whose value can differ between Light and Dark.
const themed = (t) => t.path[0] === 'color' || t.path[0] === 'components'
const untouchedByTheme = (t) => !themed(t)

const isRem = (t) => ['fontSize', 'lineHeight'].includes(t.path.at(-1)) // sizes follow the user's font setting
const dartNum = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))
const px = (v) => parseFloat(v)

const cssValue = {
  type: 'value',
  transform: (t) => {
    const v = t.$value
    switch (t.$type) {
      case 'cubicBezier':
        return `cubic-bezier(${v.join(', ')})`
      case 'fontFamily':
        return `${v}, system-ui, sans-serif`
      case 'dimension':
        return isRem(t) ? `${px(v) / 16}rem` : v
      case 'string':
        return String(v).replace(/^(\d+):(\d+)$/, '$1 / $2') // aspect ratio
      default:
        return v
    }
  },
}

const dartValue = {
  type: 'value',
  transform: (t) => {
    const v = t.$value
    switch (t.$type) {
      case 'color': {
        const h = String(v).slice(1).toUpperCase()
        const rgb = h.slice(0, 6)
        return `Color(0x${h.length === 8 ? h.slice(6) : 'FF'}${rgb})`
      }
      case 'dimension':
        return dartNum(px(v)) // dp / sp
      case 'number':
        return dartNum(v)
      case 'fontWeight':
        return `FontWeight.w${v}`
      case 'duration':
        return `Duration(milliseconds: ${px(v)})`
      case 'cubicBezier':
        return `[${v.map(dartNum).join(', ')}]`
      default:
        return JSON.stringify(String(v))
    }
  },
}

function platforms(file, className, filter, extra) {
  return { [file]: { transformGroup: file.startsWith('css') ? 'kkj/css' : 'kkj/dart', files: [{ destination: file.startsWith('css') ? 'tokens.css' : 'tokens.dart', format: file.startsWith('css') ? 'css/variables' : 'flutter/class.dart', filter, options: { className, ...extra } }] } }
}

function theme(name, platformList) {
  return new StyleDictionary({
    usesDtcg: true,
    log: { verbosity: 'silent', warnings: 'error' },
    source: [src('common'), src(name)],
    hooks: {
      transforms: { 'kkj/css/value': cssValue, 'kkj/dart/value': dartValue },
      transformGroups: {
        'kkj/css': ['name/kebab', 'kkj/css/value'],
        'kkj/dart': ['name/camel', 'kkj/dart/value'],
      },
    },
    platforms: Object.assign({}, ...platformList),
  })
}

async function render(sd, platform) {
  await sd.hasInitialized
  return (await sd.formatPlatform(platform))[0].output
}

const fontFace = [
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
]
  .map(
    ([w, f]) =>
      `@font-face {\n  font-family: 'Pretendard';\n  font-weight: ${w};\n  font-style: normal;\n  font-display: swap;\n  src: url('../fonts/Pretendard-${f}.woff2') format('woff2');\n}\n`,
  )
  .join('\n')

export async function generate() {
  const light = theme('light', [
    platforms('css', undefined, undefined, { selector: ':root' }),
    platforms('dartLight', 'KkjLight', themed),
    platforms('dartCommon', 'KkjTokens', untouchedByTheme),
  ])
  const dark = theme('dark', [
    platforms('cssDark', undefined, themed, { selector: '[data-theme="dark"]' }),
    platforms('dartDark', 'KkjDark', themed),
  ])
  const cssLight = await render(light, 'css')
  const cssDark = await render(dark, 'cssDark')
  // Cut the generated header off the Dark part; fail loudly if its shape changes.
  const cut = (text, marker) => {
    const i = text.indexOf(marker)
    if (i < 0) throw new Error(`generated output has no "${marker}"`)
    return text.slice(i)
  }
  const css = `${cssLight}\n${cut(cssDark, '[data-theme')}\n${fontFace}`
  const dartParts = [await render(light, 'dartCommon'), await render(light, 'dartLight'), await render(dark, 'dartDark')]
  // Each part repeats the header and import; keep them once.
  const dart = dartParts[0] + '\n' + dartParts.slice(1).map((p) => cut(p, 'class ')).join('\n')
  return { css, dart }
}

// Resolved values (references followed) by token name, per theme.
export async function loadTokens(name) {
  const sd = theme(name, [platforms('css', undefined, undefined, {})])
  await sd.hasInitialized
  const out = {}
  for (const t of (await sd.getPlatformTokens('css')).allTokens) out[t.path.join('.')] = { value: t.$value, type: t.$type }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { css, dart } = await generate()
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'tokens.css'), css)
  writeFileSync(join(outDir, 'tokens.dart'), dart)
}
