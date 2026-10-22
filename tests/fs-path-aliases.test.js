'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net')
const {spawn}=require('node:child_process'),{once}=require('node:events')

test('a HOME directory alias cannot expose canonical sensitive directories or custom token files', {timeout:20000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-alias-protection-')),home=path.join(root,'home'),alias=path.join(root,'home-alias')
  fs.mkdirSync(home)
  fs.symlinkSync(home,alias,process.platform==='win32'?'junction':'dir')
  // These protected files deliberately do not exist at gateway startup.
  const tokenFile=path.join(alias,'custom-secret.txt'),privateDir=path.join(home,'.dsh-remote')
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
  const env={...process.env,HOME:alias,USERPROFILE:alias,DSH_HOME:alias,DSH_REMOTE_FS_ROOT:home,TOKEN:'alias-protection-test-token',TOKEN_FILE:tokenFile,HOST:'127.0.0.1',PORT:String(port),DSH_UPSTREAM:'http://127.0.0.1:1',DSH_REMOTE_DSH_CONTROL_MODE:'disabled',UPDATE_CHECK_URL:'http://127.0.0.1:1/update',DSH_REMOTE_ANNOUNCEMENTS_URL:''}
  for(const key of Object.keys(env))if(/proxy/i.test(key))delete env[key]
  const child=spawn(process.execPath,[path.resolve(__dirname,'../gateway.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let logs='';child.stdout.on('data',chunk=>{logs+=chunk});child.stderr.on('data',chunk=>{logs+=chunk})
  t.after(async()=>{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited}
    if(process.platform==='win32')fs.rmdirSync(alias);else fs.unlinkSync(alias)
    fs.rmSync(root,{recursive:true,force:true})
  })
  const base='http://127.0.0.1:'+port,headers={authorization:'Bearer alias-protection-test-token'}
  let ready=false
  for(let i=0;i<100;i++){try{ready=(await fetch(base+'/health',{signal:AbortSignal.timeout(200)})).ok}catch{}if(ready)break;if(child.exitCode!==null)assert.fail(logs);await new Promise(resolve=>setTimeout(resolve,30))}
  assert.ok(ready,logs)
  fs.mkdirSync(privateDir,{recursive:true});fs.writeFileSync(path.join(privateDir,'device-keys.json'),'test-only-private');fs.writeFileSync(tokenFile,'test-only-custom-secret')
  for(const target of [path.join(home,'custom-secret.txt'),path.join(privateDir,'device-keys.json')]){
    const res=await fetch(base+'/fs/file?path='+encodeURIComponent(target),{headers})
    assert.equal(res.status,403,target);await res.text()
  }
  const response=await fetch(base+'/fs/list?path='+encodeURIComponent(home),{headers});assert.equal(response.status,200)
  const body=await response.json()
  assert.ok(!body.entries.some(entry=>['.dsh-remote','custom-secret.txt'].includes(entry.name)))
})
