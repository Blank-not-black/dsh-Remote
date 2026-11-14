'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

test('both shells use the same process rows, completed-turn controls and live reasoning', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(file)
    assert.match(source, /prepared=activity\.group\(prepared, \{/, file)
    assert.match(source, /liveReasoning: groupLive/, file)
    assert.match(source, /if \(entry\.view\?\.activityGroup\) return window\.DshActivity\.groupHtml\(/, file)
    assert.match(source, /if \(entry\.view\?\.activityTurn\) return window\.DshActivity\.turnHtml\(/, file)
  }
  const css = read('public/workflow.css')
  assert.match(css, /\.chat-activity-group\.is-running/)
  assert.match(css, /activity-ring/)
  assert.match(css, /\.activity-state i::after/)
  assert.match(css, /box-shadow:0 0 7px currentColor/)
  assert.match(css, /\.chat-activity-group \{/)
  assert.match(css, /\.chat-activity-group\[open\]/)
  assert.match(css, /\.chat-activity-turn/)
  assert.match(css, /\.activity-nested-tools/)
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(file)
    assert.match(source, /suppressBlockTools/, `${file} suppresses duplicate inline tool blocks`)
    assert.match(source, /history\.suppressBlockTools/, file)
  }
  assert.match(read('public/history.js'), /if\(!html&&!failed\)\{if\(this\.nodes\.delete\(entry\.seq\)\)changed=true;continue\}/)
})
