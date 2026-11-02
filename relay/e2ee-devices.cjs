'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {fault}=require('./registry.cjs')
const {createPairing,DEVICE_PROTOCOL}=require('./e2ee-channel.cjs')
const {HOSTNAME}=require('./e2ee-identity.cjs')
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const ID=/^[a-f0-9]{32}$/,HASH=/^[a-f0-9]{64}$/
class DeviceStore{
  constructor(root,identity){
    this.file=path.join(root,'e2ee','devices.json')
    this.identity=identity;this.fingerprint=createPairing(identity.certificate,HOSTNAME).fingerprint
    if(fs.existsSync(this.file)){
      const stat=fs.lstatSync(this.file)
      if(stat.isSymbolicLink()||!stat.isFile()||stat.size>256*1024)throw fault('E2EE_DEVICE_STATE_INVALID')
      try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'))}catch{throw fault('E2EE_DEVICE_STATE_INVALID')}
      if(this.state?.schema!==1||this.state.fingerprint!==this.fingerprint||!Array.isArray(this.state.devices)
        ||this.state.devices.length>64||this.state.devices.some(d=>!ID.test(d?.id||'')||!HASH.test(d?.routeTokenHash||'')||!HASH.test(d?.secretHash||'')||!Number.isFinite(d.expiresAt)||!Number.isFinite(d.createdAt)||d.revokedAt!==null&&!Number.isFinite(d.revokedAt)||typeof d.label!=='string'||!d.label.trim()||d.label.length>80||/[\x00-\x1f]/.test(d.label))
        ||new Set(this.state.devices.map(d=>d.id)).size!==this.state.devices.length)throw fault('E2EE_DEVICE_STATE_INVALID')
    }else this.save({schema:1,fingerprint:this.fingerprint,devices:[]})
  }
  save(state){
    const temp=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp'
    try{fs.writeFileSync(temp,JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file);this.state=state}
    finally{fs.rmSync(temp,{force:true})}
  }
  active(id){const d=this.state.devices.find(d=>d.id===id);return d&&!d.revokedAt&&d.expiresAt>Date.now()?d:null}
  list(){return this.state.devices.map(({id,label,createdAt,expiresAt,revokedAt})=>({id,label,createdAt,expiresAt,revokedAt:revokedAt||null,active:!!this.active(id)}))}
  routes(){return this.state.devices.filter(d=>this.active(d.id)).map(({id,routeTokenHash,expiresAt})=>({id,routeTokenHash,expiresAt})).sort((a,b)=>a.id.localeCompare(b.id))}
  create({label,expiresAt,publicUrl}){
    if(typeof label!=='string'||!label.trim()||label.length>80||/[\x00-\x1f]/.test(label)||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+366*86400000)throw fault('INVALID_DEVICE')
    if(this.routes().length>=32)throw fault('E2EE_DEVICE_LIMIT',409)
    const origin=new URL(publicUrl);if(origin.protocol!=='https:'||origin.username||origin.password)throw fault('INVALID_DEVICE')
    const id=crypto.randomBytes(16).toString('hex'),routeToken=crypto.randomBytes(32).toString('base64url'),deviceSecret=crypto.randomBytes(32).toString('base64url')
    const record={id,label:label.trim(),routeTokenHash:hash(routeToken),secretHash:hash(deviceSecret),createdAt:Date.now(),expiresAt,revokedAt:null}
    const retained=this.state.devices.filter(d=>this.active(d.id)).concat(this.state.devices.filter(d=>!this.active(d.id)).slice(-31))
    this.save({...this.state,devices:[...retained,record]})
    const certificate=new crypto.X509Certificate(this.identity.certificate)
    return {device:{id,label:record.label,expiresAt},pairing:{...createPairing(this.identity.certificate,HOSTNAME),protocol:DEVICE_PROTOCOL,
      relayUrl:new URL('/relay/v1/e2ee',origin).href,routeToken,deviceId:id,deviceSecret,expiresAt,
      publicKeyHash:hash(certificate.publicKey.export({type:'spki',format:'der'})),label:record.label}}
  }
  revoke(id){
    if(!ID.test(id||'')||!this.state.devices.some(d=>d.id===id))throw fault('DEVICE_NOT_FOUND',404)
    this.save({...this.state,devices:this.state.devices.map(d=>d.id===id?{...d,revokedAt:d.revokedAt||Date.now()}:d)})
  }
  authorize(value){
    const match=/^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(String(value||''))
    const device=match&&this.active(match[1])
    if(!device||!crypto.timingSafeEqual(Buffer.from(hash(match[2]),'hex'),Buffer.from(device.secretHash,'hex')))throw fault('RELAY_DEVICE_UNAUTHORIZED',403)
    return device.id
  }
}
module.exports={DeviceStore}
