'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8')
test('background startup failures are reported instead of claiming the receiver is running',()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{checked:true,value:'0.5',options:[],textContent:'',classList:{toggle(){},add(){}},removeAttribute(){}});return nodes.get(id)}
 const c=vm.createContext({$:get,state:{server:'http://fixture',token:'fixture'},location:{origin:'http://fixture'},CLIENT_ID:'test',window:{NativeBackground:{saveBackgroundConfig:()=>false,getBackgroundConfig:()=>JSON.stringify({enabled:true,serviceRunning:false,serviceState:'start-failed',notifyTaskDone:true})}},I18N:{lang:'zh'},t:k=>k,syncCustomSelect(){}})
 vm.runInContext(source.slice(source.indexOf('function bgBridge()'),source.indexOf('/* ---------------- 预设提示词')),c)
 assert.equal(c.saveBgConfig(true),false);c.applyBgConfigFromNative();assert.match(get('bg-auth-status').textContent,/未运行|start-failed/)
 c.window.NativeBackground.getBackgroundConfig=()=>JSON.stringify({enabled:true,loginExpired:true});c.applyBgConfigFromNative();assert.equal(get('bg-auth-status').textContent,'settings.bgAuthFailed')
})
test('native receiver restores enabled settings at foreground entry and hands off before WebView pause',()=>{
 const activity=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/MainActivity.java'),'utf8'),service=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/RemotePollService.java'),'utf8')
 assert.match(activity,/public void onStart\(\)[\s\S]*?RemotePollService.restoreIfEnabled/)
 assert.match(activity,/public void onPause\(\)[\s\S]*?RemotePollService.restoreIfEnabled[\s\S]*?super.onPause/)
 assert.match(service,/getBoolean\(KEY_LOGIN_EXPIRED, false\)/);assert.match(service,/onTimeout\(int startId, int foregroundServiceType\)/)
 assert.match(service,/if \(stopped \|\| !prefs.getBoolean\(KEY_ENABLED/)
})

test('foreground fallback polling resolves a delivered batch before its baseline and requests',async()=>{
 const calls=[],frame=(type,id)=>({rpcId:id,payload:{type,approvalId:id,sessionId:'S'}})
 const baseline=frame('approval/requested','closed'),requested=frame('approval/requested','closed'),resolved=frame('approval/resolved','closed')
 const bridge={handlePendingEvent:(_base,_token,json,enabled)=>calls.push({frame:JSON.parse(json),enabled})}
 const c=vm.createContext({state:{streamMode:'poll',token:'fixture',pollSeq:{mux:10}},CAP:null,AbortSignal,
  window:{NativeBackground:bridge},captureConnection:()=>({valid:()=>true}),clientIdHeaders:()=>({}),apiUrl:value=>value,bgBase:()=> 'http://fixture',
  fetch:async()=>({ok:true,status:200,json:async()=>({latestSeq:13,baseline:[baseline],events:[{seq:5,event:frame('approval/resolved','old')},{seq:11,event:requested},{seq:12,event:resolved},{seq:13,event:frame('approval/requested','open')}]})}),
  onMuxFrame:value=>bridge.handlePendingEvent('http://fixture','fixture',JSON.stringify(value),true),onHostFrame(){},renderPending(){},scheduleRefresh(){}})
 const start=source.indexOf('async function pollKind('),end=source.indexOf('\nfunction tryRestoreWs(',start)
 vm.runInContext(source.slice(start,end),c);await c.pollKind('mux')
 assert.equal(calls[0].frame.payload.type,'approval/resolved');assert.equal(calls[0].frame.payload.approvalId,'closed');assert.equal(calls[0].enabled,false)
 assert.equal(calls.some(value=>value.frame.payload.approvalId==='old'),false,'ignore resolutions below the active cursor')
 assert.equal(calls[1].frame.payload.type,'approval/requested');assert.equal(c.state.pollSeq.mux,13)
})
