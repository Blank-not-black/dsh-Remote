'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process')

// Execute the production Java policy against small OS fakes. No Android/JUnit dependency.
test('Android pending reminders deduplicate foreground/poll/replay, isolate credentials, clear resolutions and retry denied posts',t=>{
 const compiler=spawnSync('javac',['-version'],{encoding:'utf8',windowsHide:true})
 if(compiler.status!==0)return t.skip('JDK unavailable; Android build still verifies API compatibility')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-pending-java-'))
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const sources={
 'android/os/Build.java':`package android.os; public class Build { public static class VERSION { public static int SDK_INT=36; } }`,
 'android/R.java':`package android; public class R { public static class drawable { public static int stat_notify_chat=1; } }`,
 'android/net/Uri.java':`package android.net; public class Uri { public static Uri parse(String s){return new Uri();} }`,
 'android/content/SharedPreferences.java':`package android.content;
 import java.util.*; public class SharedPreferences {
  private Map<String,Object> data=new HashMap<>(); public Map<String,?> getAll(){return new HashMap<>(data);}
  public boolean getBoolean(String k,boolean d){return data.get(k) instanceof Boolean?(Boolean)data.get(k):d;} public long getLong(String k,long d){return data.get(k) instanceof Long?(Long)data.get(k):d;} public int getInt(String k,int d){return data.get(k) instanceof Integer?(Integer)data.get(k):d;} public boolean contains(String k){return data.containsKey(k);} public Editor edit(){return new Editor();}
  public class Editor { private Map<String,Object> puts=new HashMap<>(); private Set<String> removes=new HashSet<>();
   public Editor putInt(String k,int v){puts.put(k,v);return this;} public Editor putLong(String k,long v){puts.put(k,v);return this;} public Editor putBoolean(String k,boolean v){puts.put(k,v);return this;}
   public Editor remove(String k){removes.add(k);return this;} public void apply(){for(String k:removes)data.remove(k);data.putAll(puts);}
  }
 }`,
 'android/content/Context.java':`package android.content;
 import android.app.NotificationManager;import java.util.*;
 public class Context { public static int MODE_PRIVATE=0; public NotificationManager manager=new NotificationManager();
  private Map<String,SharedPreferences> prefs=new HashMap<>(); public SharedPreferences getSharedPreferences(String k,int m){return prefs.computeIfAbsent(k,x->new SharedPreferences());}
  public <T> T getSystemService(Class<T> t){return t.cast(manager);} public String getString(int id){return "text-"+id;}
 }`,
 'android/content/Intent.java':`package android.content; import android.net.Uri;import java.util.*;
 public class Intent { public static int FLAG_ACTIVITY_SINGLE_TOP=1,FLAG_ACTIVITY_CLEAR_TOP=2; public Map<String,String> extras=new HashMap<>();
  public Intent(Context c,Class<?> type){} public Intent setAction(String s){return this;}public Intent setData(Uri u){return this;}
  public Intent setFlags(int f){return this;}public Intent putExtra(String k,String v){extras.put(k,v);return this;}
 }`,
 'android/app/PendingIntent.java':`package android.app; import android.content.*;
 public class PendingIntent {public static int FLAG_UPDATE_CURRENT=1,FLAG_IMMUTABLE=2;public Intent intent;
  public static PendingIntent getActivity(Context c,int id,Intent i,int flags){PendingIntent p=new PendingIntent();p.intent=i;return p;}
 }`,
 'android/app/NotificationChannel.java':`package android.app; public class NotificationChannel {public String id;public int importance;
  public NotificationChannel(String id,String name,int importance){this.id=id;this.importance=importance;}public int getImportance(){return importance;}public void enableVibration(boolean enabled){}
 }`,
 'android/app/NotificationManager.java':`package android.app; import java.util.*;
 public class NotificationManager {public static int IMPORTANCE_HIGH=4,IMPORTANCE_NONE=0;public boolean enabled=true,deny=false;public int posts=0;
  public Map<String,Notification> active=new HashMap<>();public Map<String,NotificationChannel> channels=new HashMap<>();
  public boolean areNotificationsEnabled(){return enabled;}public void createNotificationChannel(NotificationChannel c){channels.putIfAbsent(c.id,c);}
  public NotificationChannel getNotificationChannel(String id){return channels.get(id);}public void cancel(String tag,int id){active.remove(tag);}
  public void notify(String tag,int id,Notification n){if(deny)throw new SecurityException();posts++;active.put(tag,n);}
 }`,
 'android/app/Notification.java':`package android.app; import android.content.Context;
 public class Notification {public static int PRIORITY_HIGH=1;public PendingIntent target;
  public static class BigTextStyle {public BigTextStyle bigText(String t){return this;}}
  public static class Builder {private Notification n=new Notification();public Builder(Context c){}public Builder(Context c,String channel){}
   public Builder setSmallIcon(int i){return this;}public Builder setContentTitle(String s){return this;}public Builder setContentText(String s){return this;}
   public Builder setStyle(BigTextStyle s){return this;}public Builder setContentIntent(PendingIntent i){n.target=i;return this;}
   public Builder setAutoCancel(boolean v){return this;}public Builder setOnlyAlertOnce(boolean v){return this;}public Builder setPriority(int i){return this;}
   public Notification build(){return n;}
  }
 }`,
 'org/json/JSONObject.java':`package org.json;import java.util.*;
 public class JSONObject {private Map<String,Object> v=new HashMap<>();public JSONObject put(String k,Object o){v.put(k,o);return this;}
  public JSONObject optJSONObject(String k){return v.get(k) instanceof JSONObject?(JSONObject)v.get(k):null;}
  public JSONArray optJSONArray(String k){return v.get(k) instanceof JSONArray?(JSONArray)v.get(k):null;}
  public Object opt(String k){return v.get(k);} public boolean optBoolean(String k,boolean d){return v.get(k) instanceof Boolean?(Boolean)v.get(k):d;} public String optString(String k,String d){return v.get(k) instanceof String?(String)v.get(k):d;} public String optString(String k){return v.get(k) instanceof String?(String)v.get(k):"";}
 }`,
 'org/json/JSONArray.java':`package org.json; public class JSONArray {private java.util.List<JSONObject> rows=new java.util.ArrayList<>();public JSONArray put(JSONObject value){rows.add(value);return this;}public int length(){return rows.size();}public JSONObject optJSONObject(int i){return i>=0&&i<rows.size()?rows.get(i):null;} }`,
 'com/dshremote/app/R.java':`package com.dshremote.app; public class R {public static class string {public static int attention_channel=1,attention_approval=2,attention_question=3,bg_events_text=4,task_result_channel=5,task_result_turn=6,task_result_goal=7,task_result_error=8,task_result_test=9;} }`,
 'com/dshremote/app/MainActivity.java':`package com.dshremote.app; public class MainActivity {}`,
 'com/dshremote/app/PendingTest.java':`package com.dshremote.app;
 import android.content.*;import android.app.*;import org.json.*;
 public class PendingTest {
  static void check(boolean v,String s){if(!v)throw new AssertionError(s);}
  static JSONObject event(String type,String id){return new JSONObject().put("rpcId",id).put("payload",new JSONObject().put("type",type).put("approvalId",id).put("questionRpcId",id).put("sessionId","S"));}
  public static void main(String[] args) throws Exception {
   Context c=new Context();JSONObject q=event("question/requested","Q");
   PendingNotifications.handle(c,"http://host/","token",q,false);check(c.manager.posts==0,"disabled");
   c.manager.enabled=false;PendingNotifications.handle(c,"http://host","token",q,true);c.manager.enabled=true;
   PendingNotifications.handle(c,"http://host/","token",q,true);check(c.manager.posts==1,"enabled after denied");
   PendingNotifications.handle(c,"http://host","token",q,true);check(c.manager.posts==1,"foreground and poll replay");
   Notification n=c.manager.active.values().iterator().next();check(n.target.intent.extras.get("pending_session").equals("S"),"session route");check(!n.target.intent.extras.containsValue("token"),"no token in Intent");
   PendingNotifications.handle(c,"http://host","other-token",q,true);check(c.manager.posts==2,"credential isolation");
   PendingNotifications.handle(c,"http://other","token",q,true);check(c.manager.posts==3,"host isolation");
   PendingNotifications.handle(c,"http://host","token",event("question/resolved","Q"),false);check(c.manager.active.size()==2,"resolved clears only owner");
   PendingNotifications.handle(c,"http://host","token",q,true);check(c.manager.posts==3,"resolved tombstone");
   PendingNotifications.handle(c,"http://host","token",event("question/resolved","early"),false);
   PendingNotifications.handle(c,"http://host","token",event("question/requested","early"),true);check(c.manager.posts==3,"resolution before replay");
   c.manager.deny=true;PendingNotifications.handle(c,"http://host","token",event("approval/requested","A"),true);c.manager.deny=false;
   PendingNotifications.handle(c,"http://host","token",event("approval/requested","A"),true);check(c.manager.posts==4,"retry failed post");
   PendingNotifications.clear(c);check(c.manager.active.isEmpty(),"disable clears notifications");
   for(int i=0;i<1100;i++)PendingNotifications.handle(c,"http://host","token",event("question/resolved","old"+i),false);
   check(c.getSharedPreferences("dsh_remote_attention",0).getAll().size()<=1025,"bounded tombstones");

   Context tasks=new Context();
   JSONObject start=new JSONObject().put("payload",new JSONObject().put("type","host/session-status").put("sessionId","S").put("running",true));
   JSONObject end=new JSONObject().put("payload",new JSONObject().put("type","host/session-status").put("sessionId","S").put("running",false));
   TaskNotifications.handle(tasks,"http://host","token",end,true,false);check(tasks.manager.posts==0,"initial idle is not completion");
   TaskNotifications.handle(tasks,"http://host","token",start,true,false);
   tasks.manager.deny=true;TaskNotifications.handle(tasks,"http://host","token",end,true,false);check(tasks.manager.posts==0,"denied task post");
   tasks.manager.deny=false;TaskNotifications.handle(tasks,"http://host","token",end,true,false);check(tasks.manager.posts==1,"retry denied task post");
   TaskNotifications.handle(tasks,"http://host","token",end,true,false);check(tasks.manager.posts==1,"duplicate terminal");
   check(tasks.manager.channels.get(TaskNotifications.CHANNEL).importance==NotificationManager.IMPORTANCE_HIGH,"audible result channel");
   Notification task=tasks.manager.active.values().iterator().next();check(task.target.intent.extras.get("pending_session").equals("S"),"task session route");check(!task.target.intent.extras.containsValue("token"),"no task token in Intent");
   TaskNotifications.handle(tasks,"http://host","token",event("host/agent-error","error"),true,false);check(tasks.manager.active.size()==1,"failure upgrades same turn");
   TaskNotifications.handle(tasks,"http://host","token",start,true,false);TaskNotifications.handle(tasks,"http://host","token",end,true,false);check(tasks.manager.active.size()==2,"next turn separate");
   TaskNotifications.handle(tasks,"http://host","token",event("goal/cleared","clear"),true,false);check(tasks.manager.active.size()==2,"clearing a goal is not completion");
   JSONObject otherStart=new JSONObject().put("payload",new JSONObject().put("type","host/session-status").put("sessionId","Other").put("running",true));
   JSONObject otherEnd=new JSONObject().put("payload",new JSONObject().put("type","host/session-status").put("sessionId","Other").put("running",false));
   TaskNotifications.handle(tasks,"http://host","token",otherStart,true,true);TaskNotifications.handle(tasks,"http://host","token",otherEnd,true,true);check(tasks.manager.active.size()==2,"historical replay stays silent");
   TaskNotifications.handle(tasks,"http://host","token",otherStart,true,false);TaskNotifications.handle(tasks,"http://host","token",otherEnd,true,false);check(tasks.manager.active.size()==3,"different session does not overwrite");
   TaskReminderPolicy policy=new TaskReminderPolicy();policy.accept("host/session-status",true,false);int outcome=policy.accept("goal/completed",null,false);check(outcome==TaskReminderPolicy.GOAL,"goal outcome");policy.delivered(outcome);
   policy.accept("host/session-status",true,false);check(policy.run==1,"goal keeps the enclosing turn active");check(policy.accept("host/session-status",false,false)==TaskReminderPolicy.NONE,"goal and turn share a single reminder");
   Context race=new Context();
   JSONObject muxStart=new JSONObject().put("payload",new JSONObject().put("sessionId","S").put("event",new JSONObject().put("type","turn/start")));
   JSONObject muxEnd=new JSONObject().put("payload",new JSONObject().put("sessionId","S").put("event",new JSONObject().put("type","turn/end")));
   TaskNotifications.handle(race,"http://host","token",muxStart,true,false);TaskNotifications.handle(race,"http://host","token",muxEnd,true,false);
   check(race.manager.posts==0,"session stream cannot invent a host cycle");
   JSONObject hostStart=new JSONObject().put("remoteEventId","host-start-1").put("payload",start.optJSONObject("payload"));
   JSONObject hostEnd=new JSONObject().put("remoteEventId","host-end-1").put("payload",end.optJSONObject("payload"));
   TaskNotifications.handle(race,"http://host","token",hostStart,true,false);TaskNotifications.handle(race,"http://host","token",hostEnd,true,false);
   check(race.manager.posts==1&&race.manager.active.size()==1,"delayed host after mux is one notification");
   TaskNotifications.handle(race,"http://host","token",muxStart,true,false);TaskNotifications.handle(race,"http://host","token",muxEnd,true,false);
   TaskNotifications.handle(race,"http://host","token",hostStart,true,false);TaskNotifications.handle(race,"http://host","token",hostEnd,true,false);
   check(race.manager.posts==1,"late session events and WS-poll duplicates do not reopen a turn");
   hostStart=new JSONObject().put("remoteEventId","host-start-2").put("payload",start.optJSONObject("payload"));
   hostEnd=new JSONObject().put("remoteEventId","host-end-2").put("payload",end.optJSONObject("payload"));
   TaskNotifications.handle(race,"http://host","token",hostStart,true,false);TaskNotifications.handle(race,"http://host","token",hostEnd,true,false);
   check(race.manager.posts==2&&race.manager.active.size()==2,"a real next host cycle is still notified without a time debounce");
   TaskReminderPolicy migrated=new TaskReminderPolicy();migrated.run=7;migrated.posted=TaskReminderPolicy.TURN;
   migrated.accept("host/session-status",true,false);check(migrated.run==7,"adopt legacy session-counted cycle");check(migrated.accept("host/session-status",false,false)==0,"migration does not re-alert");
   migrated.accept("host/session-status",true,false);check(migrated.run==8,"next cycle after migration");
   Context batch=new Context();
   PendingNotifications.handleBatch(batch,"http://host","token",new JSONArray().put(event("approval/requested","done")).put(event("approval/resolved","done")),true);
   check(batch.manager.posts==0&&batch.manager.active.isEmpty(),"resolved-in-batch approvals never post");
   PendingNotifications.handleBatch(batch,"http://host","token",new JSONArray().put(event("question/resolved","done-q")).put(event("question/requested","done-q")).put(event("question/requested","open-q")),true);
   check(batch.manager.posts==1&&batch.manager.active.size()==1,"batch only posts still-open questions, independent of order");
   Context denied=new Context();denied.manager.deny=true;
   check(!TaskNotifications.test(denied,"http://host","token","approval")&&denied.manager.posts==0,"approval test reports system rejection");
   denied.manager.deny=false;check(TaskNotifications.test(denied,"http://host","token","approval")&&denied.manager.posts==1,"approval test reports actual post");
   Context retryTask=new Context();
   TaskNotifications.handle(retryTask,"http://host","token",hostStart,true,false);retryTask.manager.deny=true;
   TaskNotifications.handle(retryTask,"http://host","token",hostEnd,true,false);retryTask.manager.deny=false;
   TaskNotifications.handle(retryTask,"http://host","token",hostEnd,true,false);check(retryTask.manager.posts==1,"event receipt is not consumed on denied task post");
   System.out.println("policy checks passed");
  }
 }`
 }
 for(const [name,text] of Object.entries(sources)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
 const actual=path.join(dir,'com/dshremote/app/PendingNotifications.java');fs.copyFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/PendingNotifications.java'),actual)
 for(const name of ['TaskReminderPolicy.java','TaskNotifications.java'])fs.copyFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app',name),path.join(dir,'com/dshremote/app',name))
 const taskSources=['TaskReminderPolicy.java','TaskNotifications.java'].map(name=>path.join(dir,'com/dshremote/app',name))
 const build=spawnSync('javac',['-encoding','UTF-8','-d',dir,...Object.keys(sources).map(name=>path.join(dir,name)),actual,...taskSources],{encoding:'utf8',windowsHide:true})
 assert.equal(build.status,0,build.stderr)
 const run=spawnSync('java',['-cp',dir,'com.dshremote.app.PendingTest'],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/policy checks passed/)
})
