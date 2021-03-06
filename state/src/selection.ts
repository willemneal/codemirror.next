import {Mapping} from "./change"
import {EditorState} from "./state"
import {charType} from "../../doc/src"

export class SelectionRange {
  constructor(public readonly anchor: number, public readonly head: number = anchor) {}

  get from(): number { return Math.min(this.anchor, this.head) }
  get to(): number { return Math.max(this.anchor, this.head) }
  get empty(): boolean { return this.anchor == this.head }

  map(mapping: Mapping): SelectionRange {
    let anchor = mapping.mapPos(this.anchor), head = mapping.mapPos(this.head)
    if (anchor == this.anchor && head == this.head) return this
    else return new SelectionRange(anchor, head)
  }

  extend(from: number, to: number = from) {
    if (from <= this.anchor && to >= this.anchor) return new SelectionRange(from, to)
    let head = Math.abs(from - this.anchor) > Math.abs(to - this.anchor) ? from : to
    return new SelectionRange(this.anchor, head)
  }

  eq(other: SelectionRange): boolean {
    return this.anchor == other.anchor && this.head == other.head
  }

  toJSON(): any { return this }

  static fromJSON(json: any): SelectionRange {
    if (!json || typeof json.anchor != "number" || typeof json.head != "number")
      throw new RangeError("Invalid JSON representation for SelectionRange")
    return new SelectionRange(json.anchor, json.head)
  }

  static groupAt(state: EditorState, pos: number, bias: 1 | -1 = 1) {
    // FIXME at some point, take language-specific identifier characters into account
    let line = state.doc.lineAt(pos), linePos = pos - line.start
    if (line.length == 0) return new SelectionRange(pos)
    if (linePos == 0) bias = 1
    else if (linePos == line.length) bias = -1
    let read = linePos + (bias < 0 ? -1 : 0), type = charType(line.slice(read, read + 1))
    let from = pos, to = pos
    for (let lineFrom = linePos; lineFrom > 0 && charType(line.slice(lineFrom - 1, lineFrom)) == type; lineFrom--) from--
    for (let lineTo = linePos; lineTo < line.length && charType(line.slice(lineTo, lineTo + 1)) == type; lineTo++) to++
    return new SelectionRange(to, from)
  }
}

export class EditorSelection {
  /** @internal */
  constructor(readonly ranges: ReadonlyArray<SelectionRange>,
              readonly primaryIndex: number = 0) {}

  map(mapping: Mapping): EditorSelection {
    return EditorSelection.create(this.ranges.map(r => r.map(mapping)), this.primaryIndex)
  }

  eq(other: EditorSelection): boolean {
    if (this.ranges.length != other.ranges.length ||
        this.primaryIndex != other.primaryIndex) return false
    for (let i = 0; i < this.ranges.length; i++)
      if (!this.ranges[i].eq(other.ranges[i])) return false
    return true
  }

  get primary(): SelectionRange { return this.ranges[this.primaryIndex] }

  asSingle() {
    return this.ranges.length == 1 ? this : new EditorSelection([this.primary])
  }

  addRange(range: SelectionRange, primary: boolean = true) {
    return EditorSelection.create([range].concat(this.ranges), primary ? 0 : this.primaryIndex + 1)
  }

  replaceRange(range: SelectionRange, which: number = this.primaryIndex) {
    let ranges = this.ranges.slice()
    ranges[which] = range
    return EditorSelection.create(ranges, this.primaryIndex)
  }

  toJSON(): any {
    return this.ranges.length == 1 ? this.ranges[0].toJSON() :
      {ranges: this.ranges.map(r => r.toJSON()), primaryIndex: this.primaryIndex}
  }

  static fromJSON(json: any): EditorSelection {
    if (json && Array.isArray(json.ranges)) {
      if (typeof json.primaryIndex != "number" || json.primaryIndex >= json.ranges.length)
        throw new RangeError("Invalid JSON representation for EditorSelection")
      return new EditorSelection(json.ranges.map((r: any) => SelectionRange.fromJSON(r)), json.primaryIndex)
    }
    return new EditorSelection([SelectionRange.fromJSON(json)])
  }

  static single(anchor: number, head: number = anchor) {
    return new EditorSelection([new SelectionRange(anchor, head)], 0)
  }

  static create(ranges: ReadonlyArray<SelectionRange>, primaryIndex: number = 0) {
    for (let pos = 0, i = 0; i < ranges.length; i++) {
      let range = ranges[i]
      if (range.empty ? range.from <= pos : range.from < pos) return normalized(ranges.slice(), primaryIndex)
      pos = range.to
    }
    return new EditorSelection(ranges, primaryIndex)
  }

  static default: EditorSelection = EditorSelection.single(0)
}

function normalized(ranges: SelectionRange[], primaryIndex: number = 0): EditorSelection {
  let primary = ranges[primaryIndex]
  ranges.sort((a, b) => a.from - b.from)
  primaryIndex = ranges.indexOf(primary)
  for (let i = 1; i < ranges.length; i++) {
    let range = ranges[i], prev = ranges[i - 1]
    if (range.empty ? range.from <= prev.to : range.from < prev.to) {
      let from = prev.from, to = Math.max(range.to, prev.to)
      if (i <= primaryIndex) primaryIndex--
      ranges.splice(--i, 2, range.anchor > range.head ? new SelectionRange(to, from) : new SelectionRange(from, to))
    }
  }
  return new EditorSelection(ranges, primaryIndex)
}
