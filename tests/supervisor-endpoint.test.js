'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{EventEmitter}=require('node:events')
const source=fs.readFileSync(path.join(__dirname,'..','gateway.js'),'utf8')
const start=source.indexOf('function supervisorSocketPath('),end=source.indexOf('async function runGatewaySupervisor(',start)
assert.ok(start>=0&&end>start)
const macTmp='/var/folders/ab/cdefghijklmnopqrstuvwxyz012345/T',key='0123456789abcdef'
function load({platform='darwin',node='22.0.0',tmpdir=macTmp,failures=[],stat,connectionError='ECONNREFUSED'}={}){
 const attempted=[],closed=[],modes=[],servers=[]
 class Server extends EventEmitter{
  listen(endpoint){this.endpoint=endpoint;attempted.push(endpoint);const failure=failures.shift();queueMicrotask(()=>{if(failure)this.emit('error',failure);else{this.listening=true;this.emit('listening')}})}
  close(){this.listening=false;closed.push(this.endpoint)}
 }
 const api=platform==='win32'?path.win32:path.posix
 const c=vm.createContext({path:api,Buffer,crypto,process:{platform,versions:{node}},os:{tmpdir:()=>tmpdir},
  fs:{realpathSync:()=>'/isolated/state',chmodSync:(...args)=>modes.push(args),statSync:()=>stat?stat():{ino:1,mtimeMs:1},unlinkSync(){}},
  net:{createServer:()=>{const server=new Server();servers.push(server);return server},connect:()=>{
   const socket=new EventEmitter();socket.destroy=()=>{};socket.setTimeout=()=>{};queueMicrotask(()=>socket.emit('error',Object.assign(Error(),{code:connectionError})));return socket
  }},fault:code=>Object.assign(Error(code),{code})})
 vm.runInContext(source.slice(start,end),c)
 return {c,attempted,closed,modes,servers,api}
}
test('macOS default TMPDIR retains its directory with a 92-byte, 16-hex file endpoint',async()=>{
 const h=load(),selected=h.c.pickSupervisorEndpoint({tmpdir:macTmp,key})
 assert.equal(path.posix.dirname(selected),macTmp);assert.equal(Buffer.byteLength(selected),92)
 const lock=await h.c.lockGatewaySupervisor('/isolated/state/lease.json')
 assert.match(h.attempted[0],/supervisor-[a-f0-9]{16}\.sock$/);assert.equal(h.attempted.length,1)
 assert.equal(lock.verifyLease,true);assert.equal(h.modes[0][1],0o600);lock.close()
})
test('oversized and multibyte TMPDIRs fall back by UTF-8 byte length',()=>{
 const {c}=load()
 for(const tmpdir of ['/'+ 'x'.repeat(120),'/'+'目录'.repeat(15)]){
  const selected=c.pickSupervisorEndpoint({tmpdir,key})
  assert.equal(path.posix.dirname(selected),'/tmp');assert.ok(Buffer.byteLength(selected)<=100)
 }
 const overhead=Buffer.byteLength(c.supervisorSocketPath('/',key))
 const exact='/'+'x'.repeat(99-overhead)
 assert.equal(Buffer.byteLength(c.pickSupervisorEndpoint({tmpdir:exact,key})),100)
 assert.equal(path.posix.dirname(c.pickSupervisorEndpoint({tmpdir:exact+'x',key})),'/tmp')
 assert.throws(()=>c.pickSupervisorEndpoint({tmpdir:'/'+'x'.repeat(120),key,fallback:'/'+'y'.repeat(120)}),{code:'SUPERVISOR_ENDPOINT_TOO_LONG'})
})
test('Windows pipes and Linux abstract sockets retain their exact 40-hex identity',async()=>{
 for(const platform of ['win32','linux']){
  const h=load({platform}),lease=h.api.join('/isolated/state','lease.json')
  let identity=h.api.join('/isolated/state',h.api.basename(lease));if(platform==='win32')identity=identity.toLowerCase()
  const digest=crypto.createHash('sha256').update(identity).digest('hex').slice(0,40)
  const lock=await h.c.lockGatewaySupervisor(lease)
  assert.deepEqual(h.attempted,[(platform==='win32'?'\\\\.\\pipe\\':'\0')+'dsh-remote-supervisor-'+digest])
  assert.equal(lock.verifyLease,false);assert.equal(h.modes.length,0);lock.close()
 }
})
test('filesystem migration holds both names and releases the new lock if an old owner conflicts',async()=>{
 for(const [platform,node]of [['darwin','22.0.0'],['linux','18.20.0'],['linux','20.7.0']]){
  const h=load({platform,node,tmpdir:'/tmp'}),lock=await h.c.lockGatewaySupervisor('/isolated/state/lease.json')
  assert.equal(h.attempted.length,2);assert.match(h.attempted[0],/supervisor-[a-f0-9]{16}\.sock$/);assert.match(h.attempted[1],/supervisor-[a-f0-9]{40}\.sock$/)
  lock.close();assert.deepEqual(h.closed,h.attempted)
 }
 const h=load({tmpdir:'/tmp',failures:[null,Object.assign(Error(),{code:'EADDRINUSE'})],connectionError:'EACCES'})
 await assert.rejects(h.c.lockGatewaySupervisor('/isolated/state/lease.json'),{code:'EADDRINUSE'})
 assert.deepEqual(h.closed,[h.attempted[0]])
})
test('file socket length failures, including a stale-socket retry, retain their cause and safe code',async()=>{
 for(const code of ['EINVAL','ENAMETOOLONG']){
  const original=Object.assign(Error('private endpoint'),{code})
  for(const failures of [[original],[Object.assign(Error(),{code:'EADDRINUSE'}),original]]){
   const {c}=load({failures})
   await assert.rejects(c.listenSupervisorEndpoint('/tmp/isolated.sock',true),error=>error.code==='SUPERVISOR_ENDPOINT_TOO_LONG'&&error.cause===original)
  }
 }
 const original=Object.assign(Error(),{code:'EINVAL'}),{c}=load({platform:'win32',failures:[original]})
 await assert.rejects(c.listenSupervisorEndpoint('pipe',false),error=>error===original)
 const codes=source.split('\n').find(line=>line.startsWith('const CRASH_CODES='))
 const context=vm.createContext({});vm.runInContext(codes+';this.codes=CRASH_CODES',context)
 for(const code of ['SUPERVISOR_ENDPOINT_TOO_LONG','EINVAL','ENAMETOOLONG'])assert.ok(context.codes.has(code))
})
test('file socket v2 migration checks command/birth identity; unchanged kernel names ignore stale v2 PIDs',async()=>{
 const begin=source.indexOf('let old=null,modifiedAt=0,recovered='),finish=source.indexOf('const temporary=lease+',begin)
 assert.ok(begin>=0&&finish>begin)
 for(const version of [undefined,2])for(const verifyLease of [false,true])for(const alive of [false,true]){
  let lookups=0
  const c=vm.createContext({lock:{verifyLease},lease:'isolated',fs:{readFileSync:()=>JSON.stringify({version,pid:42}),statSync:()=>({mtimeMs:1})},
   legacyGatewaySupervisorAlive:async(owner,modifiedAt)=>{lookups++;assert.equal(owner.pid,42);assert.equal(modifiedAt,1);return alive}})
  const result=vm.runInContext('(async()=>{'+source.slice(begin,finish)+'})()',c),expected=version!==2||verifyLease
  if(expected&&alive)await assert.rejects(result,{code:'SUPERVISOR_ALREADY_RUNNING'});else await result
  assert.equal(lookups,expected?1:0)
 }
})
test('Unix migration parses C-locale ps command and birth time; reused and unverifiable PIDs stay distinct',async()=>{
 const begin=source.indexOf('async function legacyGatewaySupervisorAlive('),finish=source.indexOf('function supervisorSocketPath(',begin)
 const born='Tue Oct 20 00:00:00 2026',modifiedAt=Date.parse(born)+5000
 let output=born+' node /isolated/gateway.cjs --supervise',failure=null
 const c=vm.createContext({path:path.posix,Buffer,process:{platform:'darwin',env:{},kill:(_pid,signal)=>assert.equal(signal,0)},
  execFile:(command,args,options,done)=>{assert.equal(command,'ps');assert.deepEqual(Array.from(args),['-p','42','-o','lstart=','-o','command=']);assert.equal(options.env.LC_ALL,'C');done(failure,output)}})
 vm.runInContext(source.slice(begin,finish),c)
 assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},modifiedAt),true)
 assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},modifiedAt-10000),false)
 output=born+' node /isolated/unrelated.js --supervise';assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},modifiedAt),false)
 output='not parseable';await assert.rejects(c.legacyGatewaySupervisorAlive({pid:42},modifiedAt),{code:'SUPERVISOR_IDENTITY_UNAVAILABLE'})
 failure=Object.assign(Error(),{code:'EACCES'});await assert.rejects(c.legacyGatewaySupervisorAlive({pid:42},modifiedAt),{code:'SUPERVISOR_IDENTITY_UNAVAILABLE'})
})
