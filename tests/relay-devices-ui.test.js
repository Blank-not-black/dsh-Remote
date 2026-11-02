'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{setImmediate:next}=require('node:timers/promises')
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.events={};this.value='';this.hidden=false}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=nodes}
 setAttribute(){}
 addEventListener(type,fn){this.events[type]=fn}
}
test('device pairing is created once and a late response cannot expose another host pairing',async()=>{
 const target=new Element('div'),calls=[];let generation=0,post
 const root={I18N:{lang:'zh'},confirm:()=>true,fetch:async(url,options)=>{calls.push({url,options});return options.method==='POST'?new Promise(r=>post=r):{ok:true,json:async()=>({devices:[],configured:true,e2ee:{enabled:true}})}}}
 const connection=()=>{const saved=generation;return {url:route=>'http://127.0.0.1:'+ (8787+saved)+route,headers:{authorization:'Bearer isolated-'+saved},valid:()=>saved===generation}}
 const context=vm.createContext({window:root,document:{createElement:tag=>new Element(tag)},URL,Blob,AbortController,JSON,Error,Date,setTimeout,clearTimeout})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/relay-devices.js'),'utf8'),context)
 const ui=root.DshRelayDevices.mount(target,{connection,path:'/relay/e2ee'})
 const host={canManageDevices:true,configured:true,e2ee:{enabled:true}}
 ui.update(host);await next();await next()
 const nodes=()=>{const walk=n=>[n,...n.children.flatMap(walk)];return walk(target)}
 const form=nodes().find(n=>n.tag==='form'),label=nodes().find(n=>n.tag==='input'),download=nodes().find(n=>n.textContent?.includes('保存配对文件'))
 label.value='private phone';form.events.submit({preventDefault(){}});form.events.submit({preventDefault(){}})
 assert.equal(calls.filter(c=>c.options.method==='POST').length,1)
 generation++;ui.update(host);post({ok:true,json:async()=>({pairing:{deviceSecret:'old-host-secret'},devices:[]})})
 await next();await next();assert.equal(download.hidden,true);assert.equal(label.value,'')
 assert.equal(calls.filter(c=>c.options.method==='POST').length,1)
 ui.destroy()
})
