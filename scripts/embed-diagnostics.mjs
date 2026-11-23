/* Share the support-report allowlist without adding a gateway runtime file. */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readEmbeddedSource } from './read-embedded-source.mjs'
const require=createRequire(import.meta.url)
const source=readEmbeddedSource(new URL('../public/diagnostics.js',import.meta.url))
const factory=source.slice(source.indexOf('function createDiagnosticSchema()'),source.indexOf('\n;(function(root)'))
const url=new URL('../gateway.js',import.meta.url),current=readEmbeddedSource(url)
const begin='// BEGIN EMBEDDED CLIENT DIAGNOSTICS',end='// END EMBEDDED CLIENT DIAGNOSTICS'
const block=`${begin}\n${factory}\nconst clientDiagnosticSchema = createDiagnosticSchema()\n${end}`
const next=current.includes(begin)?current.slice(0,current.indexOf(begin))+block+current.slice(current.indexOf(end)+end.length)
  :current.replace('function compatibilityDiagnostics()',()=>block+'\n\nfunction compatibilityDiagnostics()')
const schemaUrl=new URL('../ops/feedback-collector/diagnostic-schema.json',import.meta.url)
const schema=JSON.stringify(require('../public/diagnostics.js').createDiagnosticSchema().definition,null,2)+'\n'
let schemaCurrent='';try{schemaCurrent=readEmbeddedSource(schemaUrl)}catch{}
if(process.argv.includes('--check')){
  if(next!==current||schemaCurrent!==schema){console.error('Client diagnostics schema is not synchronized');process.exitCode=1}
}else{
  if(next!==current)writeFileSync(url,next)
  if(schemaCurrent!==schema)writeFileSync(schemaUrl,schema)
}
