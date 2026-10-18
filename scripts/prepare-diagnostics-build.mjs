import { createHash } from 'node:crypto'
import { readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join,relative } from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version
const files=[]
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())walk(file);else if(/\.(?:js|html|css|java)$/.test(item.name))files.push(file)}}
walk(join(root,'public'));walk(join(root,'android/app/src/main/java'))
const hash=createHash('sha256').update(version)
const inputs=files.map(file=>({file,name:relative(root,file).replaceAll('\\','/')})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
for(const {file,name}of inputs){hash.update(name+'\0');hash.update(readFileSync(file,'utf8').replaceAll('\r\n','\n')+'\0')}
writeFileSync(join(root,'public/build.json'),JSON.stringify({schema:1,version,buildId:hash.digest('hex')},null,2)+'\n')
