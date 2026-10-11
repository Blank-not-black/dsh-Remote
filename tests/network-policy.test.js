'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {PollLoop}=require('../public/network.js')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const tick=()=>new Promise(setImmediate)
test('Independent polling receives a second approval without waiting for an idle host channel',async()=>{
 const jobs={mux:[],host:[]},timers=[],loop=new PollLoop({active:()=>true,capture:()=>({valid:()=>true}),read:(kind,signal)=>{const j=deferred();jobs[kind].push({...j,signal});return j.promise},setTimer:(fn,delay)=>{timers.push({fn,delay});return timers.length},clearTimer(){}})
 const first=loop.tick();assert.equal(jobs.host.length,1);assert.equal(jobs.mux.length,1)
 jobs.mux[0].resolve(100);await tick();assert.equal(timers[0].delay,100);timers[0].fn();assert.equal(jobs.mux.length,2);assert.equal(jobs.host.length,1)
 jobs.mux[1].resolve(100);jobs.host[0].resolve(100);await first;loop.stop();assert.ok(jobs.mux[1].signal.aborted)
})
test('Failed reads back off; stopping polling cancels both requests and pending timers',async()=>{
 const timers=[],cleared=[],loop=new PollLoop({active:()=>true,capture:()=>({valid:()=>true}),read:async()=>undefined,setTimer:(fn,delay)=>{timers.push({fn,delay});return timers.length},clearTimer:id=>cleared.push(id)})
 await loop.tick();assert.equal(timers[0].delay,4000);timers[0].fn();await tick();assert.equal(timers[2].delay,8000)
 loop.stop();assert.equal(Object.keys(loop.jobs).length,0);assert.ok(cleared.includes(2))
})
test('Weak-network settings alter read budgets and paging without changing send retry semantics',()=>{
 const values=new Map(),root={navigator:{connection:{effectiveType:'4g',downlink:10,rtt:20}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}}
 const c=vm.createContext({globalThis:root,module:{exports:{}},AbortController,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/network.js'),'utf8'),c)
 const api=c.module.exports;assert.equal(api.profile().historyPageSize,60);api.setMode('weak');assert.equal(api.profile().historyPageSize,20);assert.equal(api.profile().readTimeout,90000)
 api.setMode('auto');api.observeLatency(1200);assert.equal(api.profile().weak,true);api.setMode('normal');assert.equal(api.profile().weak,false)
 api.setMode('auto');api.observeLatency(100);root.navigator.connection.effectiveType='2g';assert.equal(api.profile().weak,true)
})
test('Desktop first setup exposes token input without calling an unsupported prompt',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.html'),'utf8')
 assert.doesNotMatch(source.slice(source.indexOf('async function start()')),/prompt\(/)
 assert.match(html,/id="desktop-token-input" type="password" autocomplete="off"/)
 assert.match(source,/if \(!state\.token\) \{ showView\('view-settings'\)/)
})
