/* These were settled on through benchmarking */

// The max size of a leaf node
const MAX_LEAF = 512
// The base size of a leaf node
const BASE_LEAF = MAX_LEAF >> 1
// The desired amount of branches per node, as an exponent of 2 (so 3
// means 8 branches)
const TARGET_BRANCH_SHIFT = 3

const iterator: symbol = typeof Symbol == "undefined" ? "__iterator" as any as symbol : Symbol.iterator

// @ts-ignore (Typescript doesn't believe we're implementing Iterator due to indirection)
export abstract class Text implements Iterable<string> {
  abstract readonly text: string;
  abstract readonly length: number;
  abstract readonly lineBreaks: number;
  abstract readonly children: ReadonlyArray<Text> | null;
  abstract replace(from: number, to: number, text: string): Text;
  abstract slice(from: number, to: number): string;
  abstract eq(other: Text): boolean;

  get lines() { return this.lineBreaks + 1 }
  iter(dir: 1 | -1 = 1): TextCursor {
    return new RawTextCursor(this, dir)
  }
  iterRange(from: number, to: number = this.length): TextCursor {
    return new PartialTextCursor(this, from, to)
  }
  [iterator](): Iterator<string> {
    let cursor = new RawTextCursor(this), result = {done: false, value: ""}
    return {next() {
      result.value = cursor.next()
      result.done = result.value.length > 0
      return result
    }}
  }

  // These are module-internal but TypeScript doesn't have a
  // way to express that.
  abstract decomposeStart(to: number, target: Text[]): void;
  abstract decomposeEnd(from: number, target: Text[]): void;

  toString() { return this.text }

  protected constructor() {}

  static create(text: string): Text {
    return text.length < MAX_LEAF ? new TextLeaf(text) : TextNode.from(text.length, TextLeaf.split(text, []))
  }
}

export interface TextCursor {
  next(skip?: number): string
}

export class TextLeaf extends Text {
  readonly lineBreaks: number;

  constructor(readonly text: string) {
    super()
    let lineBreaks = 0
    // FIXME use configured line ending? Fixed special char?
    for (let pos = 0, next; (next = text.indexOf("\n", pos)) > -1; pos = next + 1) lineBreaks++
    this.lineBreaks = lineBreaks
  }

  get length(): number {
    return this.text.length
  }

  get children() { return null }

  replace(from: number, to: number, text: string): Text {
    return Text.create(this.text.slice(0, from) + text + this.text.slice(to))
  }

  slice(from: number, to: number = this.text.length): string {
    return this.text.slice(from, to)
  }

  eq(other: Text): boolean {
    return other == this || (other instanceof TextLeaf ? this.text == other.text : eqContent(this, other))
  }

  decomposeStart(to: number, target: Text[]) {
    target.push(new TextLeaf(this.text.slice(0, to)))
  }

  decomposeEnd(from: number, target: Text[]) {
    target.push(new TextLeaf(this.text.slice(from)))
  }

  static split(text: string, target: Text[]): Text[] {
    // FIXME maybe introduce some random (or deterministic) jitter
    // here to prevent getting too many equal-sized nodes in the tree
    // (which are more expensive to compare)
    for (let i = 0;;) {
      if (i + MAX_LEAF > text.length) {
        target.push(new TextLeaf(text.slice(i)))
        break
      }
      // Don't cut in the middle of a surrogate pair
      let end = i + BASE_LEAF, after = text.charCodeAt(end)
      if (after >= 0xdc00 && after < 0xe000) end++
      target.push(new TextLeaf(text.slice(i, end)))
      i = end
    }
    return target
  }
}

export class TextNode extends Text {
  readonly lineBreaks: number;

  constructor(readonly length: number, readonly children: ReadonlyArray<Text>) {
    super()
    let lineBreaks = 0
    for (let i = 0; i < children.length; i++) lineBreaks += children[i].lineBreaks
    this.lineBreaks = lineBreaks
  }

  get text(): string {
    let result = ""
    for (let i = 0; i < this.children.length; i++)
      result += this.children[i].text
    return result
  }

  replace(from: number, to: number, text: string): Text {
    let lengthDiff = text.length - (to - from), newLength = this.length + lengthDiff
    if (newLength <= BASE_LEAF) return new TextLeaf(this.slice(0, from) + text + this.slice(to))

    let children
    for (let i = 0, pos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (from >= pos && to <= end &&
          (lengthDiff > 0
           ? child.length + lengthDiff < Math.max(newLength >> (TARGET_BRANCH_SHIFT - 1), MAX_LEAF)
           : child.length + lengthDiff > newLength >> TARGET_BRANCH_SHIFT)) {
        // Fast path: if the change only affects one child and the
        // child's size remains in the acceptable range, only update
        // that child
        children = this.children.slice()
        children[i] = child.replace(from - pos, to - pos, text)
        return new TextNode(newLength, children)
      } else if (end > from) {
        // Otherwise, we must build up a new array of children
        if (children == null) children = this.children.slice(0, i)
        if (pos < from) {
          if (end == from) children.push(child)
          else child.decomposeStart(from - pos, children)
          if (end >= to) TextLeaf.split(text, children)
        }
        if (pos >= to) children.push(child)
        else if (end > to) child.decomposeEnd(to - pos, children)
      }
      pos = end
    }
    return children ? TextNode.from(newLength, children) : this
  }

  slice(from: number, to: number = this.length): string {
    let result = ""
    for (let i = 0, pos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (to > pos && from < end)
        result += child.slice(Math.max(0, from - pos), Math.min(child.length, to - pos))
      pos = end
    }
    return result
  }

  eq(other: Text): boolean {
    return this == other || eqContent(this, other)
  }

  decomposeStart(to: number, target: Text[]) {
    for (let i = 0, pos = 0;; i++) {
      let child = this.children[i], end = pos + child.length
      if (end <= to) {
        target.push(child)
      } else {
        if (pos < to) child.decomposeStart(to - pos, target)
        break
      }
      pos = end
    }
  }

  decomposeEnd(from: number, target: Text[]) {
    for (let i = 0, pos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (pos >= from) target.push(child)
      else if (end > from && pos < from) child.decomposeEnd(from - pos, target)
      pos = end
    }
  }

  static from(length: number, children: Text[]): Text {
    if (children.length == 0) return new TextLeaf("")

    let chunkLength = length >> TARGET_BRANCH_SHIFT, maxLength = chunkLength << 1, minLength = chunkLength >> 1
    let chunked: Text[] = [], currentLength = 0, currentChunk: Text[] = []
    function add(child: Text) {
      let childLength = child.length, last
      if (childLength > maxLength && child instanceof TextNode) {
        for (let i = 0; i < child.children.length; i++) add(child.children[i])
      } else if (childLength > minLength && (currentLength > minLength || currentLength == 0)) {
        flush()
        chunked.push(child)
      } else if (child instanceof TextLeaf && currentLength > 0 &&
                 (last = currentChunk[currentChunk.length - 1]) instanceof TextLeaf &&
                 child.length + last.length <= BASE_LEAF) {
        currentLength += childLength
        currentChunk[currentChunk.length - 1] = new TextLeaf(last.text + child.text)
      } else {
        if (currentLength + childLength > chunkLength) flush()
        currentLength += childLength
        currentChunk.push(child)
      }
    }
    function flush() {
      if (currentLength > 0) {
        chunked.push(currentChunk.length == 1 ? currentChunk[0] : TextNode.from(currentLength, currentChunk))
        currentLength = 0
        currentChunk.length = 0
      }
    }

    for (let i = 0; i < children.length; i++) add(children[i])
    flush()
    return chunked.length == 1 ? chunked[0] : new TextNode(length, chunked)
  }
}

function eqContent(a: Text, b: Text): boolean {
  if (a.length != b.length) return false
  let iterA = a.iter(), iterB = b.iter()
  for (let strA = iterA.next(), strB = iterB.next();;) {
    let lenA = strA.length, lenB = strB.length
    if (lenA == lenB) {
      if (strA != strB) return false
      strA = iterA.next(); strB = iterB.next()
      if (strA.length == 0) return true
    } else if (lenA > lenB) {
      if (strA.slice(0, lenB) != strB) return false
      strA = strA.slice(lenB)
      strB = iterB.next()
    } else {
      if (strB.slice(0, lenA) != strA) return false
      strB = strB.slice(lenA)
      strA = iterA.next()
    }
  }
}

class RawTextCursor implements TextCursor {
  private nodes: Text[];
  private offsets: number[];

  /** @internal */
  constructor(text: Text, public dir: 1 | -1 = 1) {
    this.nodes = [text]
    this.offsets = [dir > 0 ? 0 : text instanceof TextLeaf ? text.length : text.children!.length]
  }

  next(skip: number = 0): string {
    for (;;) {
      let last = this.nodes.length - 1
      if (last < 0) return ""
      let top = this.nodes[last]
      let offset = this.offsets[last]
      if (top instanceof TextLeaf) {
        this.nodes.pop()
        this.offsets.pop()
        if (this.dir > 0) {
          let len = top.length - offset
          if (len > skip) return top.text.slice(offset + skip)
          else skip -= len
        } else {
          if (offset > skip) return top.text.slice(0, offset - skip)
          else skip -= offset
        }
      } else if (offset == (this.dir > 0 ? top.children!.length : 0)) {
        this.nodes.pop()
        this.offsets.pop()
      } else {
        let next = top.children![this.dir > 0 ? offset : offset - 1], len = next.length
        this.offsets[last] = offset + this.dir
        if (skip > len) {
          skip -= len
        } else {
          this.nodes.push(next)
          this.offsets.push(this.dir > 0 ? 0 : next instanceof TextLeaf ? next.length : next.children!.length)
        }
      }
    }
  }
}

class PartialTextCursor implements TextCursor {
  cursor: RawTextCursor;
  limit: number;
  skip: number;

  constructor(text: Text, start: number, end: number) {
    this.cursor = new RawTextCursor(text, start > end ? -1 : 1)
    if (start > end) {
      this.skip = text.length - start
      this.limit = start - end
    } else {
      this.skip = start
      this.limit = end - start
    }
  }

  next(): string {
    let value = this.cursor.next(this.skip)
    this.skip = 0
    if (value.length > this.limit)
      value = this.cursor.dir > 0 ? value.slice(0, this.limit) : value.slice(value.length - this.limit)
    this.limit -= value.length
    return value
  }
}
