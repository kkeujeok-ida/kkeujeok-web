import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import { defaultPenSlots } from '../../model/pen'
import { SIZE_STEPS } from '../../model/textLayout'
import { COLOR_NAME } from './PenToolbar'
import type { EditInfo, Writer } from './writer'

const BAR_GAP = 8

/**
 * A text box in edit (Story 4.10): a DOM textarea over the box takes the typing (IME, selection, screen reader) and the
 * canvas draws the formatted text beneath it, so the glyphs of the textarea are transparent. The bar above it
 * (below when there is no room) sets size, color, bold and italic. Both carry `data-text-edit`: a press on them is not
 * "outside the box".
 */
export function TextEditOverlay({ info, writer, origin, onDone }: { info: EditInfo; writer: Writer; origin: { x: number; y: number }; onDone: () => void }) {
  const { t } = useI18n()
  const area = useRef<HTMLTextAreaElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [barSize, setBarSize] = useState({ w: 220, h: 52 })

  // The caret starts at the end of the text, in the textarea, once it is on screen.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    // A press that created the box may take focus after this: once more on the next frame.
    const id = globalThis.requestAnimationFrame?.(() => {
      if (document.activeElement !== el && writer.editing) el.focus({ preventScroll: true })
    })
    return () => {
      if (id !== undefined) globalThis.cancelAnimationFrame?.(id)
    }
  }, [writer])

  // The textarea is at least as tall as the laid-out box, and grows when the browser wraps it onto more lines.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(info.height, el.scrollHeight)}px`
  })
  useLayoutEffect(() => {
    const el = bar.current
    if (el && el.offsetWidth > 0 && (el.offsetWidth !== barSize.w || el.offsetHeight !== barSize.h)) setBarSize({ w: el.offsetWidth, h: el.offsetHeight })
  })

  const f = info.format
  const sync = () => {
    const el = area.current
    if (el) writer.editSelect(el.selectionStart, el.selectionEnd)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // During an IME composition Esc and Enter only settle the composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      writer.commitEdit()
      onDone()
      return
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase()
      const key = k === 'b' || e.code === 'KeyB' ? 'bold' : k === 'i' || e.code === 'KeyI' ? 'italic' : null
      if (key) {
        e.preventDefault()
        writer.editFormat({ [key]: !f[key] })
      }
    }
  }

  const aboveTop = info.top - barSize.h - BAR_GAP
  const barTop = aboveTop >= 0 ? aboveTop : Math.min(info.top + info.height + BAR_GAP, Math.max(0, info.h - barSize.h))
  const barLeft = Math.max(0, Math.min(info.left, info.w - barSize.w))
  const keep = (e: { preventDefault: () => void }) => e.preventDefault() // the textarea keeps focus and its selection
  const sizes: number[] = [...SIZE_STEPS]
  if (f.size !== null && !sizes.includes(f.size)) sizes.push(f.size)
  sizes.sort((a, b) => a - b)
  const color = f.color ?? defaultPenSlots[0]!.color
  const colorName = defaultPenSlots.find((p) => p.color === color)
  const toggle = (name: 'bold' | 'italic', label: string, glyph: string) => (
    <button
      type="button"
      className="toolbar-action text-format-btn"
      aria-pressed={f[name]}
      aria-label={fmt(t(f[name] ? 'editor.formatOn' : 'editor.formatOff'), { name: label })}
      title={label}
      style={name === 'bold' ? { fontWeight: 700 } : { fontStyle: 'italic' }}
      onMouseDown={keep}
      onClick={() => writer.editFormat({ [name]: !f[name] })}
    >
      {glyph}
    </button>
  )

  return (
    <>
      <textarea
        key={info.id}
        ref={area}
        data-text-edit=""
        className="text-edit-area"
        aria-label={t('editor.textEdit')}
        defaultValue={info.text}
        spellCheck={false}
        style={{
          left: origin.x + info.left,
          top: origin.y + info.top,
          width: info.width,
          height: info.height,
          fontSize: info.size * info.scale,
          lineHeight: 1.4,
          transform: info.rotation ? `rotate(${info.rotation}deg)` : undefined,
        }}
        onInput={(e) => writer.editInput(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
        onSelect={sync}
        onKeyUp={sync}
        onMouseUp={sync}
        onKeyDown={onKeyDown}
      />
      <div ref={bar} role="toolbar" aria-label={t('editor.formatBar')} className="text-format-bar" data-text-edit="" style={{ left: origin.x + barLeft, top: origin.y + barTop }}>
        <select
          className="text-format-size"
          aria-label={f.size !== null ? fmt(t('editor.fontSizeValue'), { size: f.size }) : t('editor.fontSize')}
          title={t('editor.fontSize')}
          value={f.size ?? ''}
          onChange={(e) => {
            if (e.target.value !== '') writer.editFormat({ size: Number(e.target.value) })
            area.current?.focus({ preventScroll: true })
          }}
        >
          {f.size === null && <option value="" />}
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="toolbar-action text-format-btn"
          aria-label={fmt(t('editor.textColorValue'), { color: colorName ? t(COLOR_NAME[colorName.colorName]) : color })}
          title={t('editor.textColor')}
          onMouseDown={keep}
          onClick={() => writer.editFormat({ color })}
        >
          <span className="selection-swatch text-format-swatch" aria-hidden="true" style={{ background: color }} />
        </button>
        {toggle('bold', t('editor.bold'), 'B')}
        {toggle('italic', t('editor.italic'), 'I')}
      </div>
    </>
  )
}
