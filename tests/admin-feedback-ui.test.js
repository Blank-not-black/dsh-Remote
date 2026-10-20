'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/admin.js'),'utf8')
const section=name=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start);return source.slice(start,end+2)}
test('feedback menu escapes its header and stays inside a short iframe viewport',()=>{
  for(const supportsPopover of [false,true]){
    let hidden=true,popover=false,focused=false
    const menu={parentElement:{},style:{},classList:{contains:()=>hidden,remove(){hidden=false},add(){hidden=true}},setAttribute(){},matches:()=>popover,querySelector:()=>({focus(){focused=true}}),getBoundingClientRect:()=>({height:Math.min(240,parseFloat(menu.style.maxHeight)||240)})}
    if(supportsPopover){menu.showPopover=()=>{popover=true};menu.hidePopover=()=>{popover=false}}
    const button={setAttribute(){},getBoundingClientRect:()=>({top:10,bottom:50,right:110})}
    const body={append(el){el.parentElement=body}}
    const c=vm.createContext({$:id=>id==='fb-menu'?menu:button,document:{body},window:{innerWidth:220,innerHeight:160}})
    for(const fn of ['positionFeedbackMenu','openFeedbackMenu','closeFeedbackMenu'])vm.runInContext(section(fn),c)
    c.openFeedbackMenu();assert.equal(menu.parentElement,body);assert.equal(focused,true)
    assert.ok(parseFloat(menu.style.left)>=8);assert.ok(parseFloat(menu.style.left)+parseFloat(menu.style.width)<=212)
    assert.ok(parseFloat(menu.style.top)>=8);assert.ok(parseFloat(menu.style.top)+menu.getBoundingClientRect().height<=152)
    assert.equal(popover,supportsPopover);c.closeFeedbackMenu();assert.equal(hidden,true);assert.equal(popover,false)
  }
})
