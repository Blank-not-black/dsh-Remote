/* Opt-in: official published plugin code, existing DSH peers, isolated state only. */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url')
test('published AgentTeams snapshot preserves blocked dependencies and matches the Remote adapter', {skip:!process.env.DSH_TEST_TEAMS_ROOT}, async t=>{
 const root=path.resolve(process.env.DSH_TEST_TEAMS_ROOT),load=name=>import(pathToFileURL(path.join(root,'lib',name)).href)
 const {createTeamDir,readTeam}=await load('state.js'),{collectTeamsActivity}=await load('snapshot.js'),{summarizeTeams}=await import('../packages/plugin/teams.mjs')
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'teams-published-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const stateRoot=path.join(home,'.agent-teams'),now=Date.now()
 const team={id:'fixture-team',name:'真实发布包快照',captainSessionId:'captain',createdAt:now,taskSeq:2,phase:'staged',
  members:[{id:'child',name:'developer',role:'实现',status:'idle',joinedAt:now}],
  tasks:[{id:'t1',subject:'Implementation',status:'pending',dependencies:[],createdAt:now,updatedAt:now},{id:'t2',subject:'Review',status:'pending',dependencies:['t1'],createdAt:now,updatedAt:now}]}
 await createTeamDir(stateRoot,team)
 await readTeam(stateRoot,team.id)
 const ctx={agents:{get:()=>undefined},logger:{warn:()=>{}}}
 const teams=await collectTeamsActivity(ctx,[{workspace:'fixture',stateRoot}])
 assert.equal(teams.length,1);assert.equal(teams[0].tasks[1].state,'blocked')
 const result=summarizeTeams({teams},{id:'w',sessionIds:['captain']})
 assert.equal(result.teams[0].tasks[1].dependencies[0],'t1');assert.equal(result.teams[0].phase,'staged')
 assert.equal(result.teams[0].members[0].id,'child')
 t.diagnostic('Published @nanmicoder/dsh-agent-teams '+JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version+' snapshot verified without model execution')
})
