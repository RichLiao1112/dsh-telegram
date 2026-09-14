/** Telegram HTML projection of model Markdown output. */

import { describe, expect, it } from 'vitest'
import { splitMarkdown, stripMarkup, toTelegramHtml } from '../src/markdown.ts'

describe('toTelegramHtml', () => {
  it('renders the supported inline subset and escapes markup characters', () => {
    expect(toTelegramHtml('**bold** and *italic* and ~~gone~~ and `a < b`'))
      .toBe('<b>bold</b> and <i>italic</i> and <s>gone</s> and <code>a &lt; b</code>')
  })

  it('keeps fenced code verbatim and renders headings, lists, quotes and rules', () => {
    expect(toTelegramHtml('```ts\nconst a = 1 < 2\n```')).toBe('<pre>const a = 1 &lt; 2</pre>')
    expect(toTelegramHtml('# Title\n- item **x**\n1. first\n> note\n---'))
      .toBe('<b>Title</b>\n• item <b>x</b>\n1. first\n▏ note\n————')
  })

  it('links absolute URLs and leaves relative ones literal', () => {
    expect(toTelegramHtml('[docs](https://example.com/a)')).toBe('<a href="https://example.com/a">docs</a>')
    expect(toTelegramHtml('[docs](docs/readme.md)')).toBe('[docs](docs/readme.md)')
  })

  it('does not format inside code spans', () => {
    expect(toTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>')
  })

  it('projects back to readable plain text', () => {
    expect(stripMarkup(toTelegramHtml('**b** <ok> `c` [t](https://e.com)'))).toBe('b <ok> c t (https://e.com)')
  })
})

describe('splitMarkdown', () => {
  it('keeps a fenced block whole and never returns an empty list', () => {
    const source = '```\nline one\nline two\n```'
    expect(splitMarkdown(source, 200)).toEqual([source])
    expect(splitMarkdown('', 100)).toEqual([''])
  })

  it('splits on line boundaries outside fences', () => {
    const chunks = splitMarkdown('aaaa\nbbbb\ncccc', 6)
    expect(chunks.join('\n')).toBe('aaaa\nbbbb\ncccc')
    expect(chunks.every(chunk => chunk.length <= 6)).toBe(true)
  })
})
