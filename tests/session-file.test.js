const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');const id='a'.repeat(64)
test('same-origin chat download resolves the gateway URL and preserves header authentication',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');let click,requested,download;
 const control={dataset:{dshAttachment:id,dshFileName:'report.txt'},closest(){return this},getAttribute(){return null},setAttribute(){},removeAttribute(){}};
 const target={addEventListener(_,fn){click=fn},contains:()=>true};
 const window={location:{href:'http://gateway.example/'},NativeFile:{downloadToDownloads:(...args)=>{download=args}}};
 const c=vm.createContext({window,URL,AbortSignal,fetch:async(url,options)=>{requested={url:url.href,options};return {ok:true}}});
 vm.runInContext(fs.readFileSync('public/chat-files.js','utf8'),c);
 window.DshChatFiles.bind(target,()=>({server:'',sessionId:'S',token:'fixture',native:true,valid:()=>true,headers:{authorization:'Bearer fixture'},notice(){}}));
 await click({target:control,preventDefault(){}});
 assert.match(requested.url,/^http:\/\/gateway.example\/remote\/api\/session-file\?/);assert.equal(requested.options.headers.authorization,'Bearer fixture');assert.equal(download[0],requested.url);assert.equal(download[2],'fixture');assert.doesNotMatch(download[0],/token=/);
})
test('attachment download proves session membership, streams exact bytes, and refuses client paths',async t=>{const {serveSessionFile}=await import('../packages/plugin/session-file.mjs');let reads=0;const bytes=Buffer.from('download fixture'),ref={attachmentId:id,name:'report.txt',bytes:bytes.length},ctx={get:name=>name==='sessionController'?{inspect:async sessionId=>({events:sessionId==='S'?[{type:'assistant/message',data:{message:{content:[{type:'file',attachment:ref}]}}}]:[]})}:{async *readFileStream(found){assert.deepEqual(found,ref);reads++;yield bytes}}};const server=http.createServer((req,res)=>void serveSessionFile(ctx,req,res,new URL(req.url,'http://host')));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port+'/?sessionId=S&attachmentId='+id;let response=await fetch(base,{method:'HEAD'});assert.equal(response.status,200);assert.equal(reads,0);response=await fetch(base);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal((await fetch(base.replace('sessionId=S','sessionId=OTHER'))).status,404);assert.equal((await fetch(base+'&path=/private')).status,400);assert.equal((await fetch(base,{method:'POST'})).status,405)})
test('file links and file blocks never interpolate host markup or treat an attachment ID as a path',()=>{const ui=require('../public/chat-files.js'),md=require('../public/md.js');assert.equal(ui.pathOf('https://evil.invalid/file'),'');assert.equal(ui.pathOf('file://remote/private'),'');assert.equal(ui.pathOf('a'.repeat(64)),'');assert.equal(ui.pathOf('file:///C:/work/report.pdf'),'C:/work/report.pdf');assert.match(md('[报告](/work/report.pdf)',{fileLinks:true}),/data-dsh-file-path/);const html=ui.render({attachment:{attachmentId:id,name:'<img src=x onerror=bad>.txt',bytes:42}});assert.doesNotMatch(html,/<img/);assert.match(html,/data-dsh-attachment/);assert.match(html,/42/);assert.doesNotMatch(ui.render({attachment:{name:'missing.txt'}}),/<button/)})
test('relative chat links require the session working directory and never alter skill Markdown',()=>{const ui=require('../public/chat-files.js'),md=require('../public/md.js');assert.equal(ui.pathOf('./report.pdf'),'');assert.equal(ui.pathOf('./report.pdf','D:/work'),'D:/work/./report.pdf');assert.match(md('[报告](./report.pdf)',{fileLinks:true}),/data-dsh-file-path/);assert.doesNotMatch(md('[技能文档](/work/SKILL.md)'),/data-dsh-file-path/);assert.doesNotMatch(md('[bad](javascript:alert)',{fileLinks:true}),/<a/)})

test('ordinary relative links, Chinese names and spaces download relative to the session, without accepting URI schemes or IDs',()=>{
 const ui=require('../public/chat-files.js'),md=require('../public/md.js')
 for(const path of ['团队/功能差异表.md','报告.docx','团队/报告 文件.pdf']){
  assert.equal(ui.pathOf(path),'');assert.equal(ui.pathOf(path,'D:/work'),'D:/work/'+path)
  assert.match(md('[文件]('+path+')',{fileLinks:true}),/data-dsh-file-path/)
  assert.match(ui.render({path,name:'文件'}),/data-dsh-file-path/)
 }
 assert.match(md('[文件](团队/报告%20文件.pdf)',{fileLinks:true}),/报告 文件\.pdf/)
 assert.match(md('[文件](<团队/报告 文件.pdf>)',{fileLinks:true}),/data-dsh-file-path="团队\/报告 文件.pdf"/)
 for(const path of ['https://host/report.pdf','data:text/plain,report.pdf','javascript:report.pdf','//host/report.pdf','\\\\host\\report.pdf','a'.repeat(64)])assert.equal(ui.pathOf(path,'D:/work'),'')
 for(const path of ['javascript:report.pdf','data:text/plain,report.pdf','//host/report.pdf','report.pdf%00'])assert.doesNotMatch(md('[文件]('+path+')',{fileLinks:true}),/data-dsh-file-path/)
 const injected=md('[文件](report%22%20onclick=%22bad.pdf)',{fileLinks:true})
 assert.doesNotMatch(injected,/" onclick=/);assert.match(injected,/&quot;/)
})

function downloadFixture({native={},responses=[{ok:true,status:200}],valid=()=>true}={}){
 const fs=require('node:fs'),vm=require('node:vm');let click;const requests=[],notices=[]
 const attributes=new Map(),control={textContent:'下载文件',dataset:{dshFilePath:'团队/报告.pdf',dshFileName:'报告.pdf'},closest(){return this},getAttribute:k=>attributes.get(k),setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)}
 const target={addEventListener(_,fn){click=fn},contains:()=>true}
 const window={location:{href:'http://gateway/'},NativeFile:native}
 const context=vm.createContext({window,URL,AbortSignal,setTimeout:fn=>{fn();return 1},fetch:async(url,options)=>{requests.push({url:url.href,options});return responses.shift()}})
 vm.runInContext(fs.readFileSync('public/chat-files.js','utf8'),context)
 window.DshChatFiles.bind(target,()=>({server:'',sessionId:'S',cwd:'/work',token:'fixture',native:true,valid,headers:{authorization:'Bearer fixture'},notice:(...args)=>notices.push(args)}))
 return {control,requests,notices,attributes,click:()=>click({target:control,preventDefault(){}})}
}
test('native downloads wait for system completion, expose failures and permit retry',async()=>{
 let calls=0,phases=[{phase:'paused'},{phase:'complete',name:'报告.pdf'}]
 const h=downloadFixture({native:{downloadToDownloads(){calls++;return '17'},getFileDownloadStatus:()=>JSON.stringify(phases.shift())},responses:[{ok:true,status:200},{ok:true,status:200}]})
 await h.click();assert.equal(calls,1);assert.match(h.control.textContent,/下载完成/);assert.equal(h.attributes.has('aria-busy'),false)
 assert.match(h.notices.at(-1)[0],/下载完成.*报告/)
 phases=[{phase:'error',error:'手机存储空间不足'}];await h.click();assert.equal(calls,2);assert.equal(h.notices.at(-1)[1],'err');assert.match(h.notices.at(-1)[0],/存储空间/)
})
test('attachment fallback uses only an explicit path and never bypasses a forbidden response',async()=>{
 const downloaded=[],h=downloadFixture({native:{downloadToDownloads:(...args)=>downloaded.push(args)},responses:[{ok:false,status:503},{ok:true,status:200}]})
 h.control.dataset.dshAttachment=id;await h.click();assert.equal(h.requests.length,2);assert.match(h.requests[1].url,/\/fs\/file/);assert.equal(new URL(h.requests[1].url).searchParams.get('path'),'/work/团队/报告.pdf');assert.equal(downloaded.length,1)
 const denied=downloadFixture({responses:[{ok:false,status:403}]});denied.control.dataset.dshAttachment=id;await denied.click();assert.equal(denied.requests.length,1);assert.match(denied.notices[0][0],/不允许/)
 const missing=downloadFixture({responses:[{ok:false,status:503}]});missing.control.dataset.dshAttachment=id;delete missing.control.dataset.dshFilePath;await missing.click();assert.equal(missing.requests.length,1);assert.match(missing.notices[0][0],/更新主机插件/)
})
test('a late preflight after switching sessions cannot enqueue a file download',async()=>{
 let valid=true,resolve,downloads=0
 const h=downloadFixture({native:{downloadToDownloads:()=>downloads++},responses:[new Promise(r=>resolve=r)],valid:()=>valid})
 const pending=h.click();valid=false;resolve({ok:true,status:200});await pending;assert.equal(downloads,0)
})
