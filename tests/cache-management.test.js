'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
function fixture(file){
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8').replaceAll('\r\n','\n'),calls=[],values={token:'credential',server:'http://host','dsh-remote-history-old':'legacy',preference:'keep'}
  let valid=true
  const state={token:'credential',server:'http://host',servers:[{id:'current'},{id:'other'}],activeGroup:'default',groupActive:{default:'current'}}
  const localStorage={get length(){return Object.keys(values).length},key:i=>Object.keys(values)[i],removeItem:key=>delete values[key]}
  const root={I18N:{lang:'en'},DshHistory:{cacheClear:async scope=>{calls.push(['history',scope]);return true}},DshImageCache:{clear:async scope=>{calls.push(['images',scope]);return true}},DshWorkflow:{clearStorage:()=>calls.push(['settings'])},NativeBackground:{}}
  const c=vm.createContext({window:root,state,localStorage,confirm:()=>true,clearTimeout,scheduleHistoryCacheSave(){},cancelHistoryLoad:()=>calls.push(['cancel-history']),historyCacheScope:()=>state.token,
    captureConnection:()=>({valid:()=>valid}),currentServerEntry:()=>({id:'current'}),LS:{del:key=>delete values[key]},saveServers(){},closeStream(){},stopPolling(){},renderServers(){},showView(){},showSettingsPage(){},toast(){},cancelPeakReminders:async()=>{},resetAnnouncementStorage(){},location:{reload:()=>calls.push(['reload'])}})
  let body
  if(file==='public/app.js'){
    body=source.slice(source.indexOf('async function clearWorkflowData('),source.indexOf('\nfunction openPluginPage(',source.indexOf('async function clearWorkflowData(')))+'\nthis.clear=clearWorkflowData'
  }else{
    const begin=source.indexOf('clear:async kind=>{'),end=source.indexOf('\n    recover:',begin)
    body='this.clear='+source.slice(begin+'clear:'.length,end).trim().replace(/,$/,'')
  }
  vm.runInContext(body,c)
  return {c,root,calls,values,invalidate:()=>{valid=false}}
}
for(const file of ['public/app.js','public/desktop/desktop.js']){
  test(file+': image-only clear preserves history, credentials and preferences',async()=>{
    const h=fixture(file);await h.c.clear('images')
    assert.deepEqual(h.calls,[['images',undefined]])
    assert.equal(h.values.token,'credential');assert.equal(h.values.preference,'keep');assert.equal(h.values['dsh-remote-history-old'],'legacy')
  })
  test(file+': all-cache clear cancels history reads and keeps settings',async()=>{
    const h=fixture(file);await h.c.clear('caches')
    assert.deepEqual(h.calls,[['cancel-history'],['history',undefined],['images',undefined]])
    assert.equal(h.values.token,'credential');assert.equal(h.values.preference,'keep')
  })
  test(file+': removing a connection clears only that identity and preserves other connections',async()=>{
    const h=fixture(file);await h.c.clear('connection')
    assert.ok(h.calls.some(row=>row[0]==='images'&&row[1]==='credential'))
    assert.ok(h.calls.some(row=>row[0]==='history'&&row[1]==='credential'))
    assert.deepEqual(h.c.state.servers.map(s=>s.id),['other'])
  })
  test(file+': switching connection during cache deletion never removes the newly selected connection',async()=>{
    const h=fixture(file);h.root.DshImageCache.clear=async scope=>{h.calls.push(['images',scope]);h.invalidate();h.c.state.token='new-credential'}
    await h.c.clear('connection');assert.equal(h.c.state.token,'new-credential');assert.equal(h.c.state.servers.length,2)
  })
}
