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
