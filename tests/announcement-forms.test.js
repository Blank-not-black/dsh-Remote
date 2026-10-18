'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const forms=require('../public/announcement-forms.js'),{createRealisticStack}=require('./fixtures/realistic-stack.cjs')
const raw={id:'signup',question:'申请试测',questions:[
  {id:'name',type:'text',question:'昵称',maxLength:20},
  {id:'needs',type:'multiple',question:'需要的功能',minSelections:1,maxSelections:2,options:[{id:'files',label:'文件'},{id:'teams',label:'团队'},{id:'chat',label:'对话'}]},
  {id:'os',type:'single',question:'系统',options:[{id:'android',label:'Android'},{id:'other',label:'其他'}]}
]}
const valid={answers:[{questionId:'name',text:' 测试者 '},{questionId:'needs',optionIds:['teams','files']},{questionId:'os',optionIds:['android']}]}
test('mixed form validation is shared with the embedded gateway and normalization is stable',()=>{
 const poll=forms.normalize(raw,'notice');assert.ok(poll);assert.deepEqual(forms.normalize(poll,'notice'),poll)
 const source=fs.readFileSync(path.join(__dirname,'../gateway.js'),'utf8'),from=source.indexOf('function createAnnouncementForms()'),to=source.indexOf('// END EMBEDDED ANNOUNCEMENT FORMS',from)
 const c=vm.createContext({});vm.runInContext(source.slice(from,to)+'\nglobalThis.api=announcementForms',c)
 const result=forms.validate(poll,valid)
 assert.equal(result.answers[0].text,'测试者');assert.deepEqual(result.answers[1].optionIds,['files','teams'])
 assert.deepEqual(JSON.parse(JSON.stringify(c.api.validate(c.api.normalize(raw,'notice'),valid))),result)
 for(const answers of [[],valid.answers.slice(1),[...valid.answers,valid.answers[0]],[...valid.answers,{questionId:'unknown',text:'x'}],valid.answers.map(a=>a.questionId==='needs'?{...a,optionIds:['files','teams','chat']}:a),valid.answers.map(a=>a.questionId==='name'?{...a,text:'x'.repeat(21)}:a)])assert.ok(forms.validate(poll,{answers}).error)
})
test('legacy votes remain compatible and rendered form content is escaped',()=>{
 const poll=forms.normalize({id:'old',question:'Q',options:[{id:'a',label:'A'},{id:'b',label:'B'}]},'notice')
 assert.equal(poll.legacy,true);assert.deepEqual(forms.validate(poll,{optionId:'b'}),{optionId:'b'})
 assert.ok(forms.validate(poll,{optionId:'bad'}).error)
 const hostile=structuredClone(raw);hostile.questions[0].question='<img onerror=x>';hostile.questions[0].placeholder='" autofocus onfocus="bad'
 const html=forms.render(forms.normalize(hostile,'notice'),[{questionId:'name',text:'</textarea><script>x</script>'}])
 assert.match(html,/type="checkbox"/);assert.match(html,/<textarea/);assert.doesNotMatch(html,/<img|<script|<textarea[^>]*"\s+autofocus/)
 assert.equal(forms.encode('n','p',{answers:[{text:'x'.repeat(2001)}]}),null)
})
test('actual gateway validates all questions and preserves a mixed response through the old collector message field',async t=>{
 const stack=await createRealisticStack();t.after(()=>stack.stop())
 fs.writeFileSync(path.join(stack.tmpRoot,'announcements.json'),JSON.stringify({items:[{id:'signup-notice',title:'申请',content:'填写',poll:raw}]}))
 const call=answers=>fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token,'content-type':'application/json'},body:JSON.stringify({type:'poll',announcementId:'signup-notice',pollId:'signup',...answers})})
 assert.equal((await call({answers:[]})).status,400)
 assert.equal(stack.records.feedback.length,0)
 const response=await call(valid);assert.equal(response.status,200);assert.equal((await response.json()).ok,true)
 const recorded=stack.records.feedback[0];assert.equal(recorded.answers[0].text,'测试者')
 const message=JSON.parse(recorded.message.slice(5));assert.deepEqual(message.answers,recorded.answers)
})
function submission(fetchImpl){
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),poll=forms.normalize(raw,'notice'),item={id:'notice',poll},stored=[],seen=[]
 let validConnection=true
 const c=vm.createContext({state:{announcement:item,localVersion:'0.8.0-rc.3'},window:{DshAnnouncementForms:{...forms,read:()=>valid.answers}},I18N:{lang:'zh'},AbortSignal,
 document:{querySelector:()=>null},$:()=>({disabled:false}),captureConnection:()=>({valid:()=>validConnection}),updateBase:()=> 'https://gateway.invalid',fetch:fetchImpl,
 announcementVote:()=>false,storeAnnouncementVote:(...a)=>stored.push(a),markAnnouncementSeen:id=>seen.push(id),renderAnnouncementPoll(){},renderAnnouncementHistory(){},t:k=>k,toast(){}})
 vm.runInContext(source.slice(source.indexOf('async function submitAnnouncementVote()'),source.indexOf('\nfunction closeAnnouncement(')),c)
 return {c,stored,seen,invalidate:()=>{validConnection=false}}
}
test('form submission coalesces clicks, never marks a switched connection read, and does not send free text to the public fallback',async()=>{
 let done,calls=0
 const ui=submission(()=>{calls++;return new Promise(resolve=>{done=resolve})})
 const pending=ui.c.submitAnnouncementVote();await ui.c.submitAnnouncementVote();assert.equal(calls,1)
 ui.invalidate();done({ok:true,status:200,json:async()=>({ok:true})});await pending;assert.deepEqual(ui.stored,[]);assert.deepEqual(ui.seen,[])
 const rejected=submission(async()=>{calls++;return{status:401,ok:false,json:async()=>({})}})
 const before=calls;await rejected.c.submitAnnouncementVote();assert.equal(calls,before+1);assert.deepEqual(rejected.stored,[])
 const accepted=submission(async()=>({status:200,ok:true,json:async()=>({ok:true})}));await accepted.c.submitAnnouncementVote();assert.equal(accepted.stored.length,1)
})
