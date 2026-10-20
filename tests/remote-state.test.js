'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const context = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/remote-state.js'),'utf8'),context)
const derive = state => context.DshRemoteState.derive(state)
const ready = { mode:'gateway', upstream:{reachable:true}, events:{mux:{connected:true},host:{connected:true}}, devices:[] }

test('Remote 状态：缺失证据不能成为健康或零连接',()=>{
  assert.equal(derive(null).phase,'unknown')
  assert.equal(derive(null).onlineCount,null)
  assert.equal(derive({mode:'gateway'}).upstream,'unknown')
  assert.equal(derive({mode:'gateway',upstream:{reachable:true}}).phase,'unknown')
  assert.equal(derive(ready).phase,'ready')
  assert.equal(derive(ready).onlineCount,0)
})
test('Remote 状态：进程存在不代表认证成功，不能误发启动导致停止',()=>{
  const model=derive({mode:'plugin',gatewayRunning:true,gatewayAuthError:'auth failed'})
  assert.equal(model.phase,'auth')
  assert.equal(model.canStart,false)
  assert.equal(model.authenticated,false)
  assert.equal(derive({mode:'plugin',gatewayRunning:true}).phase,'attention')
  assert.equal(derive({mode:'plugin',gatewayRunning:false,gatewayInstalled:true}).canStart,true)
})
test('Remote 状态：实时降级、上游失败与未确认分别表达',()=>{
  assert.equal(derive({...ready,events:{mux:{connected:false},host:{connected:true}}}).phase,'partial')
  assert.equal(derive({...ready,upstream:{reachable:false}}).phase,'upstream')
  assert.equal(derive({...ready,upstream:{}}).phase,'unknown')
  assert.equal(derive({...ready,events:{}}).realtime,'unknown')
})
test('Remote 状态：在线客户端不混入管理员、离线记录或未知 IP',()=>{
  const model=derive({...ready,devices:[
    {kind:'admin',online:true},{kind:'unknown',online:true},{kind:'app',online:true},
    {kind:'web',online:true},{kind:'app',online:false}
  ]})
  assert.equal(model.onlineCount,2)
  assert.equal(model.connections.length,3)
  assert.equal(model.history,true)
  assert.equal(derive({...ready,deviceKeys:{entries:[{id:'known'}]}}).history,true)
})
