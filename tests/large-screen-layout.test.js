'use strict'
// Issue 54: the mobile shell used a hard-coded 720px column, so a tablet in
// landscape showed wide empty gutters. The breakpoints are intentionally asserted
// here so a later cleanup cannot silently drop large-screen support again.
const {test} = require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const getCss = () => fs.readFileSync(path.join(__dirname,'..','public','styles.css'),'utf8').replaceAll('\r\n','\n')

test('large-screen breakpoints widen the shared content column and composer', () => {
  const css = getCss()
  const tablet = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(css)
  assert.ok(tablet, 'missing the 900px breakpoint')
  assert.match(tablet[1], /\.main \{[^}]*max-width: 1100px/)
  assert.match(tablet[1], /\.main \{[^}]*padding-left: 28px/)
  assert.match(tablet[1], /\.main \{[^}]*padding-right: 28px/)
  assert.match(tablet[1], /\.composer-wrap \{[^}]*max-width: 1100px/)
  const wide = /@media \(min-width: 1400px\) \{([\s\S]*?)\n\}/.exec(css)
  assert.ok(wide, 'missing the 1400px breakpoint')
  assert.match(wide[1], /\.main \{[^}]*max-width: 1320px/)
  assert.match(wide[1], /\.composer-wrap \{[^}]*max-width: 1320px/)
})

test('phone widths keep the 720px column and only got the larger breakpoints', () => {
  const css = getCss()
  assert.match(css, /\.main \{ padding: 12px 12px 20px; max-width: 720px; margin: 0 auto; \}/)
  assert.match(css, /\.composer-wrap \{[\s\S]*?max-width: 720px; margin: 0 auto;/)
  // The big-screen rules must only exist inside the two min-width blocks.
  const outside = css.replace(/@media \(min-width: 900px\) \{[\s\S]*?\n\}/,'').replace(/@media \(min-width: 1400px\) \{[\s\S]*?\n\}/,'')
  assert.doesNotMatch(outside, /max-width: 1100px/)
  assert.doesNotMatch(outside, /max-width: 1320px/)
})
