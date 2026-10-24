'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const boundedMarkdown = require('./fixtures/bounded-markdown.cjs')

test('markdown timeout harness interrupts an intentionally non-progressing renderer', () => {
  const render = boundedMarkdown({ source: 'module.exports = () => { while (true) {} }', timeout: 50 })
  assert.throws(() => render('fixture'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' })
})

test('markdown marker, whitespace and line-ending cross product keeps content and reaches the next block', t => {
  const render = boundedMarkdown()
  const markers = ['#', '##', '###', '####', '>', '>>', '-', '+', '*', '0.', '01.', '123456789.', '1234567890.', '1)']
  const gaps = [' ', '\t', '\u00a0', '\v', '\f', '\u2028', '\u2029', '\ufeff']
  const endings = ['\n', '\r\n', '\r']
  let count = 0
  for (const marker of markers) for (const gap of gaps) for (const indent of ['', '   ', '\t']) for (const eol of endings) {
    const id = count++
    const html = render(indent + marker + gap + 'KEEP_' + id + gap + 'TAIL_' + id + eol + '# END_' + id + eol)
    const label = JSON.stringify({ marker, gap, indent, eol })
    assert.ok(html.includes('KEEP_' + id), label)
    assert.ok(html.includes('TAIL_' + id), label)
    assert.ok(html.includes('<h1>END_' + id + '</h1>'), label)
  }
  t.diagnostic('marker matrix: ' + count + ' deterministic inputs')
})

test('seeded mixed-block documents have identical LF and mixed-newline output', t => {
  const render = boundedMarkdown()
  let seed = 0x22c0ffee
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const lines = ['plain', '', '# heading', '### subheading', '> quote', '>> nested quote', '- item', '* item', '+ item', '1. ordered', '2) ordered', '   continuation', '\t- nested', '| a | b |', '| --- | --- |', '| c | d |', '```', '```js', '```dsh-ui', '{"type":"text","content":"ok"}', '# keep\u2028text', '> keep\u2029text', '[safe](https://example.com)', '[bad](javascript:alert(1))', '<script>evil()</script>', '**bold** and `code`']
  const endings = ['\n', '\r\n', '\r']
  for (let sample = 0; sample < 256; sample++) {
    let mixed = ''
    for (let i = 0, length = 4 + next(25); i < length; i++) mixed += lines[next(lines.length)] + endings[next(endings.length)]
    const expected = render(mixed.replace(/\r\n?/g, '\n'))
    const actual = render(mixed)
    assert.equal(actual, expected, 'seed 0x22c0ffee sample ' + sample + ': ' + JSON.stringify(mixed))
    assert.ok(!actual.includes('<script>evil()'), 'raw script at sample ' + sample)
  }
  t.diagnostic('seed 0x22c0ffee: 256 reproducible documents')
})

test('every streamed prefix of mixed-newline fences, lists and links completes safely', t => {
  const render = boundedMarkdown()
  const fixtures = [
    '# heading\r\n> quote\r\n1. parent\r\n   - child\r\n\r\nEND',
    '```js\r\nconst a = "<script>evil()</script>"\r\n```\r\n# after',
    '```dsh-ui\r\n{"type":"text","content":"ok"}\r\n```\r\nEND',
    '| a | b |\r\n| --- | --- |\r\n| **bold** | [x](https://example.com) |',
    '# keep\u2028text\n> keep\u2029text\n[safe](https://example.com) ![image](https://example.com/a.png)'
  ]
  let count = 0
  for (const source of fixtures) for (let end = 0; end <= source.length; end++) {
    const html = render(source.slice(0, end))
    assert.equal(typeof html, 'string')
    assert.ok(!html.includes('<script>evil()'), 'prefix ' + end)
    count++
  }
  t.diagnostic('streamed prefixes: ' + count)
})

test('deep lists and long malformed blocks finish with leaf text and following messages intact', () => {
  const render = boundedMarkdown({ timeout: 3000 })
  const nested = Array.from({ length: 96 }, (_, i) => '  '.repeat(i) + '- LEVEL_' + i).join('\r\n')
  const html = render(nested + '\r\n\r\n# AFTER_DEPTH')
  for (let i = 0; i < 96; i++) assert.ok(html.includes('LEVEL_' + i))
  assert.ok(html.includes('<h1>AFTER_DEPTH</h1>'))
  const fallback = Array.from({ length: 1000 }, (_, i) => '# KEEP_' + i + '\u2028&lt;tail&gt;').join('\r\n')
  const large = render(fallback + '\r\n# END_LARGE\r\n' + '*[]()'.repeat(3000) + '\r\nTAIL_LARGE')
  assert.equal((large.match(/KEEP_\d+/g) || []).length, 1000)
  assert.ok(large.includes('<h1>END_LARGE</h1>'))
  assert.ok(large.includes('TAIL_LARGE'))
})

test('browser global, CommonJS and shipped plugin render the same boundary inputs and options', () => {
  const renderers = [boundedMarkdown(), boundedMarkdown({ browser: true }), boundedMarkdown({ browser: true, filename: require.resolve('../packages/plugin/public/md.js') })]
  const inputs = ['# title\r\n> quote\r', '# keep\u2028tail\n# after', '1. parent\r\n   - child\r\n', '[file](D:/work/test.txt)', '![alt](https://example.com/a.png)', '```dsh-ui\r\n{"type":"text","content":"ok"}\r\n```', '```html\r\n<b>hello</b>\r\n```']
  for (const input of inputs) for (const options of [{}, { richContent: false }, { fileLinks: true, imageLabel: 'Image' }, { imageHosts: ['example.com'] }]) {
    const expected = renderers[0](input, options)
    for (const render of renderers.slice(1)) assert.equal(render(input, options), expected)
  }
})
