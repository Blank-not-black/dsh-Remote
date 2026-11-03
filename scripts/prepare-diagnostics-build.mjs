import { createHash } from 'node:crypto'
import { readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join,relative,dirname,resolve,sep } from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version
const files=[]
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())walk(file);else if(/\.(?:js|html|css|java)$/.test(item.name))files.push(file)}}
walk(join(root,'public'));walk(join(root,'android/app/src/main/java'))
const hash=createHash('sha256').update(version)
const inputs=files.map(file=>({file,name:relative(root,file).replaceAll('\\','/')})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
// Hash canonical HTML, not our generated cache keys: repeated syncs must converge.
function canonical(source) {
  return source.replaceAll('\r\n','\n')
    .replace(/<meta name="dsh-remote-build" content="[a-f0-9]{64}">[ \t]*\n?/g,'')
    .replace(/\b(src|href)=(['"])([^'"<>]+)\2/g,(all,attr,quote,url)=>{
      if(/^(?:[a-z]+:|\/\/)/i.test(url))return all
      const at=url.indexOf('?');if(at<0)return all
      const query=url.slice(at+1).split('&').filter(part=>!/^dsr-build=[a-f0-9]{64}$/.test(part)).join('&')
      return attr+'='+quote+url.slice(0,at)+(query?'?'+query:'')+quote
    })
}
for(const {file,name}of inputs){hash.update(name+'\0');hash.update((name.endsWith('.html')?canonical(readFileSync(file,'utf8')):readFileSync(file,'utf8').replaceAll('\r\n','\n'))+'\0')}
const buildId=hash.digest('hex')
for(const {file,name}of inputs.filter(row=>row.name.endsWith('.html'))) {
  let html=canonical(readFileSync(file,'utf8'))
  if(!/<head\b/i.test(html))continue
  html=html.replace(/(<head\b[^>]*>\n?)/i,'$1<meta name="dsh-remote-build" content="'+buildId+'">\n')
  html=html.replace(/\b(src|href)=(['"])([^'"<>]+)\2/g,(all,attr,quote,url)=>{
    if(/^(?:[a-z]+:|\/\/|#)/i.test(url)||!/^.*\.(?:js|css)(?:\?.*)?$/.test(url))return all
    // admin.html is served at /admin/ui, whose ../ assets resolve at public/.
    const target=resolve(name==='public/admin.html'?join(root,'public/admin'):dirname(file),url.split('?')[0])
    if(!target.startsWith(resolve(root,'public')+sep))return all
    return attr+'='+quote+url+(url.includes('?')?'&':'?')+'dsr-build='+buildId+quote
  })
  if(html!==readFileSync(file,'utf8'))writeFileSync(file,html)
}
writeFileSync(join(root,'public/build.json'),JSON.stringify({schema:1,version,buildId},null,2)+'\n')
