'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process')
test('Diagnostic build IDs survive Git CRLF normalization and change when the same RC source changes',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-build-id-'))
 try{
  for(const [name,lineEnd]of [['windows','\r\n'],['linux','\n']]){
   const root=path.join(tmp,name);for(const folder of ['public','scripts','android/app/src/main/java'])fs.mkdirSync(path.join(root,folder),{recursive:true})
   fs.copyFileSync(path.join(__dirname,'../scripts/prepare-diagnostics-build.mjs'),path.join(root,'scripts/prepare-diagnostics-build.mjs'))
   fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.8.0-rc.4'}))
   fs.writeFileSync(path.join(root,'public/app.js'),['const a=1','const b=2',''].join(lineEnd))
   fs.writeFileSync(path.join(root,'android/app/src/main/java/Main.java'),['class Main {','}',''].join(lineEnd))
  }
  const run=name=>{const root=path.join(tmp,name),env={...process.env,HOME:root,USERPROFILE:root,DSH_REMOTE_FS_ROOT:root,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};delete env.NODE_USE_ENV_PROXY;const result=spawnSync(process.execPath,['scripts/prepare-diagnostics-build.mjs'],{cwd:root,env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(fs.readFileSync(path.join(root,'public/build.json'),'utf8')).buildId}
  const first=run('windows');assert.equal(first,run('linux'));fs.appendFileSync(path.join(tmp,'linux/public/app.js'),'const c=3\n');assert.notEqual(first,run('linux'))
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
})
