'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
const code = source.slice(source.indexOf('async function sendSessionText('), source.indexOf('function hideComposerMenu('))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
function setup() {
  const elements = new Map(), settings = new Map(), timers = new Map(), calls = [], notices = []
  let timerId = 0
  const $ = id => {
    if (!elements.has(id)) {
      const classes = new Set(), events = {}
      elements.set(id, { value: '', textContent: '', dataset: {}, disabled: false, events,
        classList: { add: x=>classes.add(x), remove: x=>classes.delete(x), contains:x=>classes.has(x), toggle(x,on){if(on)classes.add(x);else classes.delete(x)} },
        setAttribute(){}, setPointerCapture(){}, addEventListener(name,fn){events[name]=fn},
      })
    }
    return elements.get(id)
  }
  const state = {server:'A', current:'s1', byId:new Map([['s1',{running:true}]]), queues:{}, pendingPrompts:new Set(),sessionActivity:new Set(),composerImages:[]}
  const context = vm.createContext({state,$,LS:{get:(k,d)=>settings.get(k)??d}, t:k=>k,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id}, clearTimeout:id=>timers.delete(id),
    toast:(...x)=>notices.push(x),setSessionRecovery(){},noteSessionTurnTime(){},renderSessions(){},autosize(){},authFailure(){},
    clearComposerImages(){state.composerImages=[]},runSlashCommand:async()=>false,
    rpc:async(method,payload)=>{calls.push({method,payload});return {accepted:true}},
    safeRpc:async(method,payload)=>{calls.push({method,payload});return {accepted:true}},
    bytesToBase64:bytes=>Buffer.from(bytes).toString('base64'),
  })
  vm.runInContext(code+';this.api={composerSendMode,sendMessage,sendSessionContent,submitSteer,bindComposerSend,renderComposerSend};',context)
  const fire = ms => { for(const [id,t] of [...timers]) if(t.ms===ms){timers.delete(id);t.fn()} }
  return {context,state,$,settings,calls,notices,timers,fire,...context.api}
}

test('插队默认关闭；开启后可反转默认；空闲统一普通发送', () => {
  const h=setup()
  assert.equal(h.composerSendMode(true),'queue')
  h.settings.set('steerSendingEnabled','1')
  assert.equal(h.composerSendMode(),'queue');assert.equal(h.composerSendMode(true),'steer')
  h.settings.set('busySendMode','steer')
  assert.equal(h.composerSendMode(),'steer');assert.equal(h.composerSendMode(true),'queue')
  h.state.byId.get('s1').running=false
  assert.equal(h.composerSendMode(),'queue')
  h.state.queues.s1=[{placement:'queued'}]
  assert.equal(h.composerSendMode(),'steer')
})

test('长按松开发送一次，合成 click 不重发；移动和 pointercancel 取消', async () => {
  const h=setup();h.settings.set('steerSendingEnabled','1')
  const sent=[];h.context.testSend=mode=>sent.push(mode);vm.runInContext('sendMessage=testSend',h.context)
  const b=h.$('btn-send');h.bindComposerSend(b)
  const e={button:0,isPrimary:true,pointerId:1,clientX:0,clientY:0,preventDefault(){}}
  b.events.pointerdown(e);h.fire(450)
  assert.equal(b.textContent,'send.releaseSteer');assert.equal(sent.length,0)
  b.events.pointerup(e);b.events.click();assert.deepEqual(sent,['steer'])
  b.events.pointerdown(e);b.events.pointermove({...e,clientX:30});h.fire(450);b.events.pointerup(e);b.events.click()
  assert.equal(sent.length,1)
  b.events.pointerdown(e);h.fire(450);b.events.pointercancel();b.events.pointerup(e);b.events.click()
  assert.equal(sent.length,1)
  b.events.pointerdown(e);b.events.pointerup(e);b.events.click();assert.deepEqual(sent,['steer','queue'])
  b.events.pointerdown(e);h.fire(450);h.state.server='B';b.events.pointerup(e)
  assert.equal(sent.length,2)
})

test('插队直接一次 RPC；慢响应前不报成功；回执仅标记 accepted', async () => {
  const h=setup();h.settings.set('steerSendingEnabled','1');h.$('composer-input').value='纠正条件'
  const d=deferred();h.context.rpc=(method,payload)=>{h.calls.push({method,payload});return d.promise}
  const sending=h.sendMessage('steer');await tick()
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload.mode,'steer')
  assert.equal(h.$('composer-send-status').textContent,'send.steerPending')
  assert.equal(h.$('btn-send').disabled,true)
  assert.equal(h.notices.length,0)
  h.fire(3000);assert.equal(h.$('composer-send-status').textContent,'send.steerSlow')
  await h.sendMessage('steer');assert.equal(h.calls.length,1)
  d.resolve({accepted:true});await sending
  assert.equal(h.$('composer-send-status').textContent,'send.steerAccepted')
  assert.equal(h.$('composer-input').value,'');assert.equal(h.timers.size,0)
})

test('超时保留输入、结果未知、不重试；明确拒绝不降级排队', async () => {
  for(const rejected of [false,true]) {
    const h=setup();h.settings.set('steerSendingEnabled','1');h.$('composer-input').value='重要条件'
    h.context.rpc=async(method,payload)=>{h.calls.push({method,payload});throw Object.assign(new Error('failure'),{rpcRejected:rejected})}
    await h.sendMessage('steer')
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload.mode,'steer')
    assert.equal(h.$('composer-input').value,'重要条件')
    assert.equal(h.$('composer-send-status').textContent,rejected?'send.steerRejected':'send.steerUnconfirmed')
    assert.equal(h.$('btn-send').disabled,false);assert.equal(h.timers.size,0)
  }
})

test('响应晚到不清空新草稿，也不把旧服务器回执显示到新服务器', async () => {
  for(const switchServer of [false,true]) {
    const h=setup();h.settings.set('steerSendingEnabled','1');h.$('composer-input').value='原文'
    const d=deferred();h.context.rpc=()=>d.promise
    const sending=h.sendMessage('steer');await tick()
    h.$('composer-input').value='新草稿'
    if(switchServer)h.state.server='B'
    d.resolve({accepted:true});await sending
    assert.equal(h.$('composer-input').value,'新草稿')
    if(switchServer)assert.notEqual(h.$('composer-send-status').textContent,'send.steerAccepted')
  }
})

test('插队不执行斜杠命令；附件准备期间切换服务器不发送到新地址', async () => {
  const h=setup();h.settings.set('steerSendingEnabled','1')
  assert.equal(await h.sendSessionContent('/reset',[],'steer'),false)
  assert.equal(h.calls.length,0)
  const d=deferred(),file={type:'image/png',name:'x.png',arrayBuffer:()=>d.promise}
  const send=h.sendSessionContent('image',[{file}],'steer');await tick()
  h.state.server='B';d.resolve(new ArrayBuffer(1));assert.equal(await send,false)
  assert.equal(h.calls.length,0)
})
