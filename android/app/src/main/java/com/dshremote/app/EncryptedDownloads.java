package com.dshremote.app;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.util.*;
import java.util.concurrent.*;

/** Stream through the current paired transport; never persist a URL or credential. */
final class EncryptedDownloads {
  private static final ExecutorService workers = Executors.newFixedThreadPool(2);
  private static final Semaphore slots = new Semaphore(2);
  private static final Set<String> active = Collections.synchronizedSet(new HashSet<String>());
  private static SharedPreferences state(Context c) { return c.getSharedPreferences("dsh-encrypted-downloads", Context.MODE_PRIVATE); }
  private static SharedPreferences pending(Context c) { return c.getSharedPreferences("dsh-encrypted-download-pending", Context.MODE_PRIVATE); }
  static synchronized void cleanup(Context c) {
    if(Build.VERSION.SDK_INT<29)return;
    for(String id:pending(c).getAll().keySet())if(!active.contains(id)){
      try {
        String value=pending(c).getString(id,"");
        Uri uri=Uri.parse(value);
        if("media".equals(uri.getAuthority())&&uri.getPath()!=null&&uri.getPath().matches("/(external|external_primary)/downloads/[0-9]+")) {
          // A crash just after publication must never delete a completed file.
          try(Cursor row=c.getContentResolver().query(uri,new String[]{MediaStore.Downloads.IS_PENDING},null,null,null)) {
            if(row!=null&&row.moveToFirst()&&row.getInt(0)==1)c.getContentResolver().delete(uri,null,null);
          }
        }
        pending(c).edit().remove(id).apply();
      }catch(Exception ignored) {}
    }
  }
  static String enqueue(Context context, String url, String name, String token) throws Exception {
    if (Build.VERSION.SDK_INT < 29) throw new IOException("加密文件保存需要 Android 10 或更新系统");
    if (!slots.tryAcquire()) throw new IOException("已有两个文件正在下载，请稍后重试");
    Context c = context.getApplicationContext(); String id = "e2ee-" + UUID.randomUUID();
    cleanup(c);
    active.add(id);
    try {
      SharedPreferences prefs=state(c);
      if(prefs.getAll().size()>=200){
        SharedPreferences.Editor edit=prefs.edit();int removed=0;
        for(String key:prefs.getAll().keySet())if(!active.contains(key)){edit.remove(key);if(++removed>=20)break;}
        edit.apply();
      }
      update(c,id,name,"downloading",0,"");
      workers.execute(() -> transfer(c,id,url,name,token));return id;
    } catch(Exception error) { active.remove(id);slots.release();throw error; }
  }
  private static void update(Context c,String id,String name,String phase,long bytes,String error) {
    try {state(c).edit().putString(id,new JSONObject().put("name",name).put("phase",phase).put("received",bytes).put("error",error).toString()).apply();} catch(Exception ignored) {}
  }
  static String status(Context c,String id) {
    String raw=state(c).getString(id,"{\"phase\":\"unknown\"}");
    try {
      JSONObject value=new JSONObject(raw);
      if("downloading".equals(value.optString("phase"))&&!active.contains(id)) {
        value.put("phase","error").put("error","下载已中断，请重新下载");return value.toString();
      }
    }catch(Exception ignored) {}
    return raw;
  }
  private static void transfer(Context c,String id,String url,String name,String token) {
    HttpURLConnection request=null;Uri destination=null;boolean complete=false;long received=0;
    try {
      request=E2eeBridge.open(c,url);request.setInstanceFollowRedirects(false);request.setConnectTimeout(15000);request.setReadTimeout(45000);
      if(token!=null&&!token.isEmpty())request.setRequestProperty("Authorization","Bearer "+token);
      int code=request.getResponseCode();if(code!=200)throw new IOException(code==401||code==403?"下载鉴权失败或设备已失效":"下载失败（"+code+"），请重新连接后重试");
      long total=request.getContentLengthLong();
      ContentValues values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,name);values.put(MediaStore.Downloads.MIME_TYPE,"application/octet-stream");
      values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/dsh-remote");values.put(MediaStore.Downloads.IS_PENDING,1);
      destination=c.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values);if(destination==null)throw new IOException("无法创建下载文件");
      if(!pending(c).edit().putString(id,destination.toString()).commit())throw new IOException("无法保存下载状态");
      try(InputStream in=request.getInputStream();OutputStream out=c.getContentResolver().openOutputStream(destination,"w")) {
        if(out==null)throw new IOException("无法打开下载文件");
        byte[] buffer=new byte[32768];int n;long last=0;
        while((n=in.read(buffer))!=-1){out.write(buffer,0,n);received+=n;if(System.currentTimeMillis()-last>500){update(c,id,name,"downloading",received,"");last=System.currentTimeMillis();}}
      }
      if(total>=0&&received!=total)throw new IOException("文件未完整接收，请重新下载");
      values.clear();values.put(MediaStore.Downloads.IS_PENDING,0);
      if(c.getContentResolver().update(destination,values,null,null)!=1)throw new IOException("无法完成下载文件");
      complete=true;update(c,id,name,"complete",received,"");
    }catch(Exception error){update(c,id,name,"error",received,error instanceof IOException?error.getMessage():"下载中断，请重新连接后重试");}
    finally{
      if(!complete&&destination!=null)try{c.getContentResolver().delete(destination,null,null);}catch(Exception ignored){}
      pending(c).edit().remove(id).apply();
      if(request!=null){request.disconnect();E2eeBridge.release(request);}active.remove(id);slots.release();
    }
  }
}
