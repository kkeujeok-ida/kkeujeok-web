import { describe, expect, test } from 'vitest'
import { MAX_PEN_SLOTS, colorNameKey, defaultPenSlots, type Pen } from '../src/model/pen'
import { addSlot, indexAfterMove, indexAfterRemove, moveSlot, pickByTool, removeSlot } from '../src/model/penSlotList'
import ko from '../src/i18n/ko.json'
import en from '../src/i18n/en.json'
import palette from '../../test/pen.palette.json'

const [black, blue, yellow] = defaultPenSlots as [Pen, Pen, Pen]

describe('slot list operations', () => {
  test('add copies the given slot to the end; a full list stays', () => {
    expect(addSlot([black, blue], 1)).toEqual([black, blue, blue])
    const full = Array.from({ length: MAX_PEN_SLOTS }, () => black)
    expect(addSlot(full, 0)).toHaveLength(MAX_PEN_SLOTS)
    expect(addSlot([black], 5)).toEqual([black])
  })

  test('move and remove', () => {
    expect(moveSlot([black, blue, yellow], 0, 2)).toEqual([blue, yellow, black])
    expect(moveSlot([black, blue, yellow], 2, 0)).toEqual([yellow, black, blue])
    expect(moveSlot([black, blue], 0, 5)).toEqual([black, blue])
    expect(removeSlot([black, blue, yellow], 1)).toEqual([black, yellow])
    expect(removeSlot([black], 0)).toEqual([black]) // the last one stays
  })

  test('indexAfterMove follows the slot', () => {
    const list = ['a', 'b', 'c', 'd']
    for (const [from, to] of [[0, 2], [2, 0], [1, 3], [3, 1], [1, 2]] as const) {
      const moved = [...list]
      moved.splice(to, 0, moved.splice(from, 1)[0]!)
      list.forEach((x, i) => expect(moved[indexAfterMove(i, from, to)]).toBe(x))
    }
  })

  test('indexAfterRemove: null for the removed slot', () => {
    expect(indexAfterRemove(2, 2)).toBeNull()
    expect(indexAfterRemove(3, 1)).toBe(2)
    expect(indexAfterRemove(0, 1)).toBe(0)
  })

  test('pickByTool: last used, else the first of that tool, else none', () => {
    const list = [black, yellow, blue, yellow]
    expect(pickByTool(list, 'pen', 2)).toBe(2)
    expect(pickByTool(list, 'pen', null)).toBe(0)
    expect(pickByTool(list, 'highlighter', 3)).toBe(3)
    expect(pickByTool(list, 'highlighter', 0)).toBe(1) // that index is no highlighter any more
    expect(pickByTool([black, blue], 'highlighter', undefined)).toBe(-1)
  })
})

describe('color names', () => {
  test('every palette color has the ko and en name of the spec', () => {
    const hexes = new Set<string>()
    for (const c of palette.cases) {
      for (const { color, ko: k, en: e } of c.expected.colors) {
        const key = colorNameKey(color) as keyof typeof ko
        expect([ko[key], en[key]]).toEqual([k, e])
        hexes.add(color)
      }
    }
    expect(hexes.size).toBe(18)
  })

  test('other colors are custom', () => {
    expect(colorNameKey('#123456')).toBe('editor.colorCustom')
    expect([ko['editor.colorCustom'], en['editor.colorCustom']]).toEqual(['사용자 지정', 'Custom'])
  })
})
