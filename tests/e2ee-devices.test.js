'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {generateIdentity,rotateIdentity,loadIdentity}=require('../relay/e2ee-identity.cjs')
const {DeviceStore}=require('../relay/e2ee-devices.cjs')
const {validatePairing}=require('../relay/e2ee-channel.cjs')
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-devices-'));fs.mkdirSync(path.join(root,'e2ee'),{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const identity=generateIdentity();return {root,identity,store:new DeviceStore(root,identity)}}
const args={label:'My Android',expiresAt:Date.now()+86400000,publicUrl:'https://alpha.relay.test'}
test('devices have independent inner and outer secrets; only hashes persist and no secret enters lists',t=>{
 const {root,identity,store}=fixture(t),a=store.create(args).pairing,b=store.create(args).pairing
 assert.notEqual(a.routeToken,b.routeToken);assert.notEqual(a.deviceSecret,b.deviceSecret)
 assert.equal(validatePairing(a).deviceId,a.deviceId)
 const persisted=fs.readFileSync(path.join(root,'e2ee/devices.json'),'utf8'),listing=JSON.stringify(store.list())
 for(const p of [a,b])for(const secret of [p.routeToken,p.deviceSecret]){assert.ok(!persisted.includes(secret));assert.ok(!listing.includes(secret))}
 const restarted=new DeviceStore(root,identity)
 assert.equal(restarted.authorize(a.deviceId+'.'+a.deviceSecret),a.deviceId)
 assert.throws(()=>restarted.authorize(a.deviceId+'.'+b.deviceSecret),/RELAY_DEVICE_UNAUTHORIZED/)
 restarted.revoke(a.deviceId);assert.throws(()=>restarted.authorize(a.deviceId+'.'+a.deviceSecret),/RELAY_DEVICE_UNAUTHORIZED/)
 assert.equal(restarted.authorize(b.deviceId+'.'+b.deviceSecret),b.deviceId)
})
test('expired devices, changed identities, corrupt stores and device limits fail closed',t=>{
 const {root,store}=fixture(t),p=store.create(args).pairing
 store.save({...store.state,devices:store.state.devices.map(d=>({...d,expiresAt:Date.now()-1}))})
 assert.throws(()=>store.authorize(p.deviceId+'.'+p.deviceSecret),/RELAY_DEVICE_UNAUTHORIZED/)
 assert.throws(()=>validatePairing({...p,expiresAt:Date.now()-1}),/INVALID_E2EE_DEVICE_PAIRING/)
 assert.throws(()=>new DeviceStore(root,generateIdentity()),/E2EE_DEVICE_STATE_INVALID/)
 for(let i=0;i<32;i++)store.create(args)
 assert.throws(()=>store.create(args),/E2EE_DEVICE_LIMIT/)
 fs.writeFileSync(path.join(root,'e2ee/devices.json'),'{bad')
 assert.throws(()=>new DeviceStore(root,store.identity),/E2EE_DEVICE_STATE_INVALID/)
})
test('explicit certificate rotation recovers expired identity and invalidates every existing device',t=>{
 const {root,identity,store}=fixture(t),p=store.create(args).pairing
 fs.writeFileSync(path.join(root,'e2ee/identity.json'),JSON.stringify(generateIdentity(Date.now()-400*86400000)))
 assert.throws(()=>loadIdentity(root))
 const next=rotateIdentity(root),fresh=new DeviceStore(root,next)
 assert.notEqual(next.certificate,identity.certificate);assert.equal(fresh.list().length,0)
 assert.throws(()=>fresh.authorize(p.deviceId+'.'+p.deviceSecret),/RELAY_DEVICE_UNAUTHORIZED/)
})
