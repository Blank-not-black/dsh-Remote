'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
test('sponsorship entry is visible without a cloud probe, reuses one route and updates language without duplicates',()=>{
 const node=()=>({children:[],events:{},append(...children){this.children.push(...children)},addEventListener(name,fn){this.events[name]=fn}}),donation=node(),relay=node(),root={I18N:{lang:'zh'}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/sponsor-entry.js'),'utf8'),{window:root,document:{createElement:node,querySelector:()=>null,querySelectorAll:()=>[donation]},fetch(){assert.fail('Entry discovery must not depend on a network request')}})
 root.DshSponsor.mount(relay);root.DshSponsor.mount(relay)
 assert.equal(relay.children.length,1);assert.equal(donation.children.length,1)
 const [link,note]=relay.children[0].children
 assert.equal(link.href,root.DshSponsor.applicationUrl);assert.equal(link.href,'https://relay-pilot.blankalwaysgoeson.site/sponsor/')
 assert.match(link.textContent,/开通、查询与续费/);assert.match(note.textContent,/¥1.*人工核验.*5GB/)
 assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer')
 link.events.click({preventDefault(){assert.fail('Web fallback should follow the link')}})
 root.I18N.lang='en';root.DshSponsor.mount(relay)
 assert.match(link.textContent,/Apply, check status or renew/);assert.equal(relay.children.length,1)
})

test('shared relay links enter the App settings hub; only its application action opens the portal',()=>{
 let entries=0, launches=0, management=0, prevented=false
 const node=()=>({children:[],events:{},append(...children){this.children.push(...children)},addEventListener(name,fn){this.events[name]=fn}})
 const donation=node(), root={NativeBackground:{openCloudRelay(){launches++},openCloudRelayManagement(){management++}}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/sponsor-entry.js'),'utf8'),{window:root,document:{createElement:node,querySelectorAll:()=>[donation]}})
 root.DshSponsor.setInAppEntry(()=>entries++)
 donation.children[0].children[0].events.click({preventDefault(){prevented=true}})
 assert.equal(prevented,true)
 assert.equal(entries,1)
 assert.equal(launches,0)
 assert.equal(root.DshSponsor.openPortal(),true)
 assert.equal(root.DshSponsor.openPortal(true),true)
 assert.equal(launches,1)
 assert.equal(management,1)
 const page=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8')
 assert.match(page,/data-settings-group="cloud-relay"/)
 assert.match(page,/<div id="settings-page-cloud-relay"[\s\S]*?<div id="relay-settings"><\/div>\s*<\/div>\s*<div id="settings-page-servers"/)
 const manifest=fs.readFileSync(path.join(__dirname,'../android/app/src/main/AndroidManifest.xml'),'utf8')
 assert.match(manifest,/<activity\s+android:name="\.CloudRelayActivity"\s+android:exported="false"/)
 const activity=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/MainActivity.java'),'utf8')
 assert.match(activity,/addJavascriptInterface\(backgroundBridge, "NativeBackground"\)/)
 assert.match(activity,/@JavascriptInterface\s+public void openCloudRelay\(\)/)
})

test('Android activation handoff is origin scoped and exposes only a read-once activation to the main page', () => {
 const root=path.join(__dirname,'../android/app/src/main/java/com/dshremote/app')
 const portal=fs.readFileSync(path.join(root,'CloudRelayActivity.java'),'utf8')
 const main=fs.readFileSync(path.join(root,'MainActivity.java'),'utf8')
 assert.match(portal,/createWebMessageChannel\(\)/)
 assert.match(portal,/postWebMessage\(new WebMessage\("dsh-relay-activation-port".*PORTAL_ORIGIN\)/)
 assert.match(portal,/port != activationPort[\s\S]{0,170}!isPortal\(Uri\.parse\(view\.getUrl\(\)\)\)/)
 assert.doesNotMatch(portal,/addJavascriptInterface/)
 assert.match(main,/takeCloudRelayActivation\(\) \{ return pendingRelayActivation\.getAndSet\(null\); \}/)
})

test('registration probe exports only status and a bounded inbox count',async()=>{
 const java=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/CloudRelayRegistration.java'),'utf8')
 const source=/READ_STATUS = """([\s\S]*?)""";/.exec(java)[1]
 const id='R1122334455667788',token='a'.repeat(43)
 for(const [stored,result,expected] of [
  [null,null,{status:'none',unread:-1}],['malformed',null,{status:'unavailable',unread:-1}],
  [JSON.stringify({id,token}),{id,status:'submitted',email:'person@example.test',unreadMessages:3},{status:'submitted',unread:3}],
  [JSON.stringify({id,token}),{id,status:'expired',renewable:true,unreadMessages:999},{status:'renewable',unread:50}],
  [JSON.stringify({id,token}),{id:'different',status:'approved',unreadMessages:2},{status:'unavailable',unread:-1}],
  [JSON.stringify({id,token}),null,{status:'unavailable',unread:-1}]
 ]){
  const window={}
  vm.runInNewContext(source,{window,localStorage:{getItem(){return stored}},fetch:async(url,options)=>{
   assert.equal(url,'/sponsor/api/applications/'+id)
   assert.equal(options.headers.authorization,'Bearer '+token)
   assert.equal(options.redirect,'error')
   return {ok:!!result,json:async()=>result}
  }})
  await new Promise(setImmediate)
  assert.deepEqual(JSON.parse(JSON.stringify(window)),{dshRegistrationProbe:expected})
 }
 const inbox={id:'R9988776655443322',token:'b'.repeat(43)},lookups=[],window={}
 vm.runInNewContext(source,{window,localStorage:{getItem(){return JSON.stringify({id,token,inbox})}},fetch:async(url,options)=>{
  lookups.push([url,options.headers.authorization])
  return url.endsWith(inbox.id)?{ok:true,json:async()=>({id:inbox.id,status:'expired',unreadMessages:4,email:'private@example.test'})}:{ok:false}
 }})
 await new Promise(setImmediate)
 assert.deepEqual(lookups,[['/sponsor/api/applications/'+id,'Bearer '+token],['/sponsor/api/applications/'+inbox.id,'Bearer '+inbox.token]])
 assert.deepEqual(JSON.parse(JSON.stringify(window)),{dshRegistrationProbe:{status:'unavailable',unread:4}})
 const main=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/MainActivity.java'),'utf8')
 assert.match(main,/onResume\(\)[\s\S]*main\.post\(pollCloudRelay\)/)
 assert.match(main,/onPause\(\)[\s\S]*main\.removeCallbacks\(pollCloudRelay\)/)
})

test('current clients remove hidden support menus and load the shared entry before relay settings',()=>{
 for(const name of ['public/index.html','public/desktop/desktop.html']){
  const html=fs.readFileSync(path.join(__dirname,'..',name),'utf8')
  assert.doesNotMatch(html,/id="(?:btn-donate|btn-feedback|btn-doctor|feedback-sheet|feedback-menu|feedback-backdrop)"/)
  assert.ok(html.indexOf('sponsor-entry.js')<html.indexOf('relay-settings.js'))
 }
 for(const name of ['public/app.js','public/desktop/desktop.js']){
  const source=fs.readFileSync(path.join(__dirname,'..',name),'utf8')
  assert.doesNotMatch(source,/(?:open|close|toggle)Feedback(?:Sheet|Menu)/)
  assert.doesNotMatch(source,/\$\('btn-(?:donate|feedback|doctor)'\)/)
 }
 const desktop=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.html'),'utf8')
 assert.match(desktop,/class="ds-action-item" data-ds-cmd/)
 assert.match(fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.css'),'utf8'),/\.ds-action-item\{/)
})
