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
  public boolean contains(String k){return data.containsKey(k);} public Editor edit(){return new Editor();}
  public class Editor { private Map<String,Object> puts=new HashMap<>(); private Set<String> removes=new HashSet<>();
   public Editor putLong(String k,long v){puts.put(k,v);return this;} public Editor putBoolean(String k,boolean v){puts.put(k,v);return this;}
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
  public NotificationChannel(String id,String name,int importance){this.id=id;this.importance=importance;}public int getImportance(){return importance;}
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
  public String optString(String k){return v.get(k) instanceof String?(String)v.get(k):"";}
 }`,
 'org/json/JSONArray.java':`package org.json; public class JSONArray {public JSONObject optJSONObject(int i){return null;} }`,
 'com/dshremote/app/R.java':`package com.dshremote.app; public class R {public static class string {public static int attention_channel=1,attention_approval=2,attention_question=3,bg_events_text=4;} }`,
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
   System.out.println("policy checks passed");
  }
 }`
 }
 for(const [name,text] of Object.entries(sources)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
 const actual=path.join(dir,'com/dshremote/app/PendingNotifications.java');fs.copyFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/PendingNotifications.java'),actual)
 const build=spawnSync('javac',['-encoding','UTF-8','-d',dir,...Object.keys(sources).map(name=>path.join(dir,name)),actual],{encoding:'utf8',windowsHide:true})
 assert.equal(build.status,0,build.stderr)
 const run=spawnSync('java',['-cp',dir,'com.dshremote.app.PendingTest'],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/policy checks passed/)
})
