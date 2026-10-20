// The loaded module determines the diagnosis target. No client path input.
import {readFileSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {doctorSkillStatus} from './doctor-skill.mjs'
export const DOCTOR_PLUGIN_ROOT = realpathSync(fileURLToPath(new URL('./',import.meta.url)))
const registries = new WeakMap()
export function watchDoctorWorkspaces(ctx) {
  if(typeof ctx?.inject!=='function')return
  ctx.inject(['workspaceRegistry'],child=>{
    registries.set(ctx,child.get('workspaceRegistry'))
    child.effect(()=>()=>registries.delete(ctx),'dsh-remote: doctor workspace targets')
  })
}
export function readDoctorTarget(ctx) {
  let version=''
  try { const pkg=JSON.parse(readFileSync(join(DOCTOR_PLUGIN_ROOT,'package.json'),'utf8'));if(pkg.name==='dsh-remote-plugin')version=pkg.version } catch {}
  let workspaces=[]
  try {
    const registry=registries.get(ctx) ?? ctx.get?.('workspaceRegistry') ?? ctx.get?.('workspace'),rows=registry?.list?.()
    if(Array.isArray(rows))workspaces=rows.slice(0,100).filter(row=>typeof row?.id==='string'&&typeof row?.path==='string').map(row=>({workspaceId:row.id.slice(0,200),title:String(row.title||row.name||'').slice(0,200),path:row.path.slice(0,4096)}))
  } catch {}
  return {ok:true,schema:1,plugin:{path:DOCTOR_PLUGIN_ROOT,version,kind:'loaded-plugin'},skill:{name:'dsh-remote-doctor',status:doctorSkillStatus(ctx)},workspaces}
}
