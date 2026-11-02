'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const copy = require('../public/chat-copy.js'), md = require('../public/md.js')
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, all => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[all]))
const sources = html => [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => decode(match[1]))

test('Markdown copy belongs to each md/markdown source block, excluding the surrounding reply and fence', () => {
  const first='# 标题\n\n**原文** 👩‍💻\n\t- [链接](https://example.test)\n<tag>&value',second='## 第二段\n\n> 保留 Markdown 标记'
  const html=md('不要复制这个开场\n\n```md\n'+first+'\n```\n\n两块之间的解释\n\n```markdown\n'+second+'\n```\n\n不要复制这个结尾',{copyCode:true})
  assert.deepEqual(sources(html),[first,second])
  assert.equal((html.match(/data-chat-copy-code/g)||[]).length,2)
  assert.equal((html.match(/aria-label="复制 Markdown"/g)||[]).length,2)
  assert.doesNotMatch(html,/data-chat-copy-markdown|<tag>|onclick=/)
  assert.equal(copy.button,undefined);assert.equal(copy.messageText,undefined)
})

test('long outer fences preserve nested Markdown code fences and streaming source', () => {
  const source='# 可直接粘贴\n\n```js\nconst text = "<script>"\n```\n\n最后一行'
  assert.deepEqual(sources(md('````markdown\n'+source+'\n````\n后记',{copyCode:true})),[source])
  assert.deepEqual(sources(md('~~~md\n'+source+'\n~~~',{copyCode:true})),[source])
  assert.deepEqual(sources(md('```markdown\r\n# 未结束\r\n\r\n- 项目',{copyCode:true})),['# 未结束\n\n- 项目'])
  assert.doesNotMatch(md('行内 `markdown` 和引用 > 段落',{copyCode:true}),/data-chat-copy-code/)
})

test('code controls are opt-in, accessible and escape source, language and custom labels', () => {
  const html=md('```js\nconst x = "<script>"\n```',{copyCode:true,copyCodeLabel:'Copy <code>'})
  assert.deepEqual(sources(html),['const x = "<script>"'])
  assert.match(html,/aria-label="Copy &lt;code&gt;"/);assert.match(html,/aria-hidden="true"/)
  assert.match(html,/chat-code-toolbar/);assert.doesNotMatch(html,/<script>|<code>js\n/)
  assert.doesNotMatch(md('```md\n# heading\n```'),/data-chat-copy-code/)
  assert.deepEqual(sources(copy.code('<tag>\n','markdown')),['<tag>\n'])
  assert.doesNotMatch(copy.code('x','"><img src=x>'),/<img/)
})

function harness(source='# 只复制这一块\n'+ '**原文** 👩‍💻\n'.repeat(5000)) {
  let handler,valid=true,resolve,calls=[],notices=[]
  const history={},status={textContent:''},attrs={'aria-label':'复制 Markdown'}
  const button={dataset:{chatCopyScope:copy.scope(history)},disabled:false,closest:()=>({querySelector:()=>({textContent:source})}),querySelector:()=>status,getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v}
  const box={dataset:{},contains:()=>true,addEventListener(name,fn){handler=fn}}
  copy.bind(box,{capture:()=>({history,valid:()=>valid}),copy:text=>{calls.push(text);return new Promise(done=>resolve=done)},notice:(...args)=>notices.push(args)})
  return {source,button,status,calls,notices,click:()=>handler({target:{closest:()=>button},preventDefault(){},stopPropagation(){}}),done:value=>resolve(value),invalidate:()=>valid=false}
}

test('copy uses only its own decoded source, rejects stale history, debounces and confirms in place',async()=>{
  const h=harness();h.button.dataset.chatCopyScope='old';await h.click();assert.equal(h.calls.length,0)
  const current=harness();const pending=current.click();await current.click();assert.deepEqual(current.calls,[current.source]);assert.equal(current.button.disabled,true)
  current.done(true);await pending;assert.equal(current.button.dataset.copyState,'copied');assert.equal(current.status.textContent,'已复制');assert.equal(current.notices.length,0)
  const again=current.click();current.invalidate();current.done(true);await again;assert.equal(current.status.textContent,'')
})

test('failed copy reports failure without claiming success',async()=>{
  const h=harness();const pending=h.click();h.done(false);await pending
  assert.equal(h.button.dataset.copyState,'error');assert.equal(h.status.textContent,'');assert.equal(h.notices[0][1],'err');assert.equal(h.button.disabled,false)
})
