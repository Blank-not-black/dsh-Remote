'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
test('sponsorship entry is visible without a cloud probe, reuses one route and updates language without duplicates',()=>{
 const node=()=>({children:[],append(...children){this.children.push(...children)}}),donation=node(),relay=node(),root={I18N:{lang:'zh'}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/sponsor-entry.js'),'utf8'),{window:root,document:{createElement:node,querySelectorAll:()=>[donation]},fetch(){assert.fail('Entry discovery must not depend on a network request')}})
 root.DshSponsor.mount(relay);root.DshSponsor.mount(relay)
 assert.equal(relay.children.length,1);assert.equal(donation.children.length,1)
 const [link,note]=relay.children[0].children
 assert.equal(link.href,root.DshSponsor.applicationUrl);assert.equal(link.href,'https://relay-pilot.blankalwaysgoeson.site/sponsor/')
 assert.match(link.textContent,/赞助 ¥1/);assert.match(note.textContent,/人工核验.*5GB/)
 assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer')
 root.I18N.lang='en';root.DshSponsor.mount(relay)
 assert.match(link.textContent,/Apply for one month/);assert.equal(relay.children.length,1)
})

test('current clients remove hidden support menus and load the shared entry before relay settings',()=>{
 for(const name of ['public/index.html','public/desktop/desktop.html']){
  const html=fs.readFileSync(path.join(__dirname,'..',name),'utf8')
  assert.doesNotMatch(html,/id="(?:btn-donate|btn-feedback|btn-doctor|feedback-sheet|feedback-menu|feedback-backdrop)"/)
  assert.ok(html.indexOf('sponsor-entry.js')<html.indexOf('relay-settings.js'))
 }
 for(const name of ['public/app.js','public/desktop/desktop.js']){
  const source=fs.readFileSync(path.join(__dirname,'..',name),'utf8')
  assert.doesNotMatch(source,/(?:open|close|toggle)Feedback(?:Sheet|Menu)/)
  assert.doesNotMatch(source,/\$\('btn-(?:donate|feedback|doctor)'\)/)
 }
 const desktop=fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.html'),'utf8')
 assert.match(desktop,/class="ds-action-item" data-ds-cmd/)
 assert.match(fs.readFileSync(path.join(__dirname,'../public/desktop/desktop.css'),'utf8'),/\.ds-action-item\{/)
})
