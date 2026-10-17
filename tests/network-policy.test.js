'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {PollLoop}=require('../public/network.js')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const tick=()=>new Promise(setImmediate)
test('concurrent workspace reads share one load and a failed load can be retried',async()=>{
 const {shareRead}=require('../public/network.js'),job=deferred();let count=0
 const a=shareRead('host-A/workspaces',()=>{count++;return job.promise}),b=shareRead('host-A/workspaces',()=>{count++;return job.promise})
 await tick();assert.equal(count,1);job.resolve({items:['one']});assert.equal((await a).items[0],'one');assert.equal((await b).items[0],'one')
 await assert.rejects(shareRead('host-B/workspaces',()=>Promise.reject(Error('offline'))),/offline/)
 assert.equal(await shareRead('host-B/workspaces',()=>Promise.resolve('recovered')),'recovered')
})
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
test('Network preferences mount after the secondary page without losing their group or change handler',()=>{
 class Element {
  constructor(tag){this.tag=tag;this.dataset={};this.children=[];this.events={};this.classList={contains:name=>name==='ds-settings'}}
  append(...nodes){this.children.push(...nodes)}
  get options(){return this.children}
  setAttribute(name,value){this[name]=value}
  addEventListener(name,fn){this.events[name]=fn}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  querySelector(selector){return this.all().find(node=>selector==='select'?node.tag==='select':selector==='input'?node.tag==='input':selector==='[data-network-title]'?Object.hasOwn(node.dataset,'networkTitle'):selector==='[data-network-detail]'?Object.hasOwn(node.dataset,'networkDetail'):selector==='[data-stream-title]'?Object.hasOwn(node.dataset,'streamTitle'):selector==='[data-stream-detail]'?Object.hasOwn(node.dataset,'streamDetail'):selector==='[data-workflow-settings-slot="input"]'?node===slot:false)}
  closest(){return section}
 }
 const panel=new Element('div'),slot=new Element('div'),section={hidden:true},values=new Map()
 panel.append(slot)
 const root={I18N:{lang:'en'},localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},document:{getElementById:id=>id==='settings-page-general'?panel:panel.all().find(node=>node.id===id),createElement:tag=>new Element(tag)}}
 const c=vm.createContext({globalThis:root,module:{exports:{}},setTimeout,clearTimeout})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/network.js'),'utf8'),c)
 const api=c.module.exports;api.preferences()
 assert.equal(section.hidden,false);assert.equal(slot.children[0].id,'network-preferences');assert.equal(panel.children.length,1)
 assert.equal(slot.children.length,2);assert.equal(slot.children[1].id,'network-stream-preferences')
 const streamRow=slot.children[1],streamInput=streamRow.querySelector('input')
 assert.equal(streamInput.checked,true,'stream trimming defaults on')
 assert.equal(streamRow.querySelector('[data-stream-title]').textContent,'No streaming on weak networks')
 const select=slot.querySelector('select');select.value='weak';select.events.change();assert.equal(api.profile().historyPageSize,20)
 assert.equal(api.streamTrimmed(),true)
 streamInput.checked=false;streamInput.events.change();assert.equal(api.streamTrimmed(),false)
 select.events.change();assert.equal(api.streamTrimmed(),false,'manual weak mode respects the switch')
 streamInput.checked=true;streamInput.events.change();assert.equal(api.streamTrimmed(),true)
 root.I18N.lang='zh';api.preferences();assert.equal(slot.children.length,2);assert.equal(slot.querySelector('[data-network-title]').textContent,'网络模式');assert.equal(slot.querySelector('[data-stream-title]').textContent,'弱网时关闭流式输出')
})
test('Desktop first setup exposes token input without calling an unsupported prompt',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.html'),'utf8')
 assert.doesNotMatch(source.slice(source.indexOf('async function start()')),/prompt\(/)
 assert.match(html,/id="desktop-token-input" type="password" autocomplete="off"/)
 assert.match(source,/if \(!state\.token\) \{ showView\('view-settings'\)/)
})
