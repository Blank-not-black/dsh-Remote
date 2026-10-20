'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url')
const adapter=import('../packages/plugin/peak-reminders.mjs')
const config={peakEnabled:true,peakEffectiveAt:'2026-08-16T16:00:00Z',peakWindows:[{start:1,end:4},{start:6,end:10}],peakHolidays:[],peakAlertEnabled:true,peakAlertAhead:2,peakAlertTarget:'both',apiKey:'SECRET'}
test('phone reminder reads cannot apply a previous host policy after switching connections',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),calls=[];let resolve,current=true
 const c=vm.createContext({CAP:{isNativePlatform:()=>true},LS:{get:()=> '1'},bgBridge:()=>({savePeakReminderConfig:raw=>{calls.push(JSON.parse(raw));return true}}),bgBase:()=> 'http://fixture',state:{token:'fixture'},CLIENT_ID:'id',I18N:{lang:'zh'},$:()=>({textContent:''}),captureConnection:()=>({server:'http://fixture',token:'fixture',valid:()=>current}),clientIdHeaders:()=>({}),AbortSignal,
  fetch:()=>new Promise(r=>{resolve=r})})
 vm.runInContext(source.slice(source.indexOf('const LEGACY_PEAK_NOTIFICATION_IDS'),source.indexOf('/* ---------------- 模型设置')),c)
 const task=c.syncPeakReminders();assert.equal(calls.length,1);current=false
 resolve({ok:true,json:async()=>({ok:true,schema:1,source:'dsh-cost-meter',available:true,enabled:true,events:[]})});await task
 assert.equal(calls.length,1)
})
test('peak schedule follows configured UTC windows, Beijing holidays/weekends, effective time and alert target',async()=>{
 const {peakReminderSchedule:make}=await adapter,now=Date.parse('2026-10-19T00:00:00Z'),s=make(config,now)
 assert.equal(s.events[0].at,Date.parse('2026-10-19T01:00:00Z'));assert.equal(s.events[0].notifyAt,s.events[0].at-120000)
 assert.doesNotMatch(JSON.stringify(s),/SECRET|apiKey|peakWindows/)
 assert.ok(s.events.every(e=>![0,6].includes(new Date(e.at+8*3600000).getUTCDay())))
 const holiday=make({...config,peakHolidays:['2026-10-19']},now);assert.equal(holiday.events[0].at,Date.parse('2026-10-20T01:00:00Z'))
 const changed=make({...config,peakWindows:[{start:3,end:5}],peakAlertAhead:15,peakAlertTarget:'offpeak'},now)
 assert.equal(changed.events[0].at,Date.parse('2026-10-19T05:00:00Z'));assert.ok(changed.events.every(e=>!e.intoPeak&&e.at-e.notifyAt===15*60000))
 assert.equal(make({...config,peakEnabled:false},now).enabled,false)
 assert.equal(make({...config,peakAlertEnabled:false},now).events.length,0)
 for(const patch of [{peakWindows:[{start:25,end:4}]},{peakAlertAhead:31},{peakHolidays:['2026-99-99']},{peakEffectiveAt:'bad'}])assert.equal(make({...config,...patch},now).available,false)
})
test('peak policy bridge is optional and never returns raw service errors or configuration',async()=>{
 const {readPeakReminders}=await adapter
 assert.equal((await readPeakReminders({})).body.available,false)
 const result=await readPeakReminders({get:()=>({getState:async()=>({config})})});assert.equal(result.body.source,'dsh-cost-meter');assert.doesNotMatch(JSON.stringify(result),/SECRET/)
 const error=await readPeakReminders({get:()=>({getState:async()=>{throw Error('SECRET')}})});assert.equal(error.status,502);assert.doesNotMatch(JSON.stringify(error),/SECRET/)
})

test('foreground phase follows all pricing transitions even when only one alert direction is enabled', async () => {
 const {peakReminderSchedule:make}=await adapter,now=Date.parse('2026-10-19T02:00:00Z')
 for(const target of ['peak','offpeak','both']){
  const s=make({...config,peakAlertTarget:target},now)
  assert.equal(s.phase.intoPeak,true)
  assert.equal(s.phase.transitions[0].at,Date.parse('2026-10-19T04:00:00Z'))
  assert.equal(s.phase.transitions[0].intoPeak,false)
  assert.ok(s.phase.transitions.some(e=>e.intoPeak)&&s.phase.transitions.some(e=>!e.intoPeak))
  assert.ok(s.phase.transitions.every((e,i)=>e.at>now&&e.at<=s.validUntil&&(!i||e.at>s.phase.transitions[i-1].at)))
  if(target!=='both')assert.ok(s.events.every(e=>e.intoPeak===(target==='peak')))
 }
 assert.equal(make({...config,peakHolidays:['2026-10-19']},now).phase.intoPeak,false)
 assert.equal(make(config,Date.parse('2026-10-24T02:00:00Z')).phase.intoPeak,false)
})
test('published cost-meter pricing agrees with every generated reminder transition',{skip:!process.env.DSH_TEST_COST_ROOT},async()=>{
 const {isPeakHour}=await import(pathToFileURL(path.join(process.env.DSH_TEST_COST_ROOT,'lib/pricing.js')).href),{peakReminderSchedule:make}=await adapter
 for(const policy of [config,{...config,peakHolidays:['2026-10-19','2026-10-20']},{...config,peakWindows:[{start:22,end:3}]}]){
  const schedule=make(policy,Date.parse('2026-10-19T00:00:00Z'))
  assert.equal(schedule.phase.intoPeak,isPeakHour(schedule.generatedAt,Date.parse(policy.peakEffectiveAt),policy.peakWindows,policy.peakHolidays))
  for(const event of schedule.phase.transitions)assert.equal(isPeakHour(event.at,Date.parse(policy.peakEffectiveAt),policy.peakWindows,policy.peakHolidays),event.intoPeak)
  for(const event of schedule.events){assert.equal(isPeakHour(event.at,Date.parse(policy.peakEffectiveAt),policy.peakWindows,policy.peakHolidays),event.intoPeak);assert.notEqual(isPeakHour(event.at-1,Date.parse(policy.peakEffectiveAt),policy.peakWindows,policy.peakHolidays),event.intoPeak)}
 }
})
test('Android delivery catches up within 30 minutes, deduplicates restarts and expires offline schedules',t=>{
 const javac=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin','javac.exe'):'javac',java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin','java.exe'):'java'
 if(spawnSync(javac,['-version'],{windowsHide:true}).status!==0)return t.skip('JDK unavailable')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'peak-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const src=path.join(dir,'com/dshremote/app');fs.mkdirSync(src,{recursive:true});fs.copyFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/PeakReminderPolicy.java'),path.join(src,'PeakReminderPolicy.java'))
 fs.writeFileSync(path.join(src,'Test.java'),`package com.dshremote.app; public class Test {static void check(boolean b){if(!b)throw new AssertionError();}public static void main(String[]args){long at=100000000L;check(PeakReminderPolicy.isDue(at-120000,at-120000,at,at+86400000,0));check(!PeakReminderPolicy.isDue(at-120001,at-120000,at,at+86400000,0));check(!PeakReminderPolicy.isDue(at,at-120000,at,at+86400000,at));check(PeakReminderPolicy.isDue(at+1800000,at-120000,at,at+86400000,0));check(!PeakReminderPolicy.isDue(at+1800001,at-120000,at,at+86400000,0));check(!PeakReminderPolicy.isDue(at,at-120000,at,at-1,0));long[]times={at+1000,at+2000};boolean[]phases={false,true};check(PeakReminderPolicy.phaseAt(at,at,at+3000,true,times,phases)==1);check(PeakReminderPolicy.phaseAt(at+1000,at,at+3000,true,times,phases)==0);check(PeakReminderPolicy.phaseAt(at+2000,at,at+3000,true,times,phases)==1);check(PeakReminderPolicy.phaseAt(at+3001,at,at+3000,true,times,phases)==-1);check(PeakReminderPolicy.phaseAt(at-1,at,at+3000,true,times,phases)==-1);check(PeakReminderPolicy.phaseAt(at,at,at+3000,true,new long[]{at+2000,at+1000},phases)==-1);check(PeakReminderPolicy.phaseAt(at,at,at+3000,true,times,new boolean[]{true})==-1);check(PeakReminderPolicy.phaseLabel(1).equals("当前峰时"));check(PeakReminderPolicy.phaseLabel(0).equals("当前谷时"));check(PeakReminderPolicy.phaseLabel(-1).equals("峰谷状态未知"));System.out.print("PEAK_POLICY_OK");}}`)
 const compile=spawnSync(javac,['-encoding','UTF-8','-d',dir,path.join(src,'PeakReminderPolicy.java'),path.join(src,'Test.java')],{encoding:'utf8',windowsHide:true});assert.equal(compile.status,0,compile.stderr)
 const result=spawnSync(java,['-cp',dir,'com.dshremote.app.Test'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PEAK_POLICY_OK/)
})
