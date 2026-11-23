package com.tongxuequan.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 没有 Google 推送服务，用 WorkManager 定时向自己的服务器取新消息，再发系统通知。
 * 系统最短 15 分钟调度一次；省电模式或国产系统的后台限制可能让间隔更长。
 */
public class PushWorker extends Worker {
    static final String PREFS = "campus_push";
    private static final String WORK = "campus_push_poll";
    private static final String WORK_NOW = "campus_push_now";

    public PushWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void schedule(Context ctx) {
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager wm = WorkManager.getInstance(ctx);
        wm.enqueueUniquePeriodicWork(
            WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(PushWorker.class, 15, TimeUnit.MINUTES).setConstraints(c).build()
        );
        // 马上跑一次，拿到起始游标
        wm.enqueueUniqueWork(WORK_NOW, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(PushWorker.class).setConstraints(c).build());
    }

    static void cancel(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK);
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NOW);
    }

    static void createChannels(Context ctx) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder("dm", NotificationManagerCompat.IMPORTANCE_HIGH).setName("私信").build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder("posts", NotificationManagerCompat.IMPORTANCE_DEFAULT).setName("关注的人发帖").build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder("interactions", NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("回复、提到和关注")
                .build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder("notice", NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("公告")
                .setDescription("学校和学生会的活动、校墙的重要通知")
                .build()
        );
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p = prefs(ctx);
        String base = p.getString("apiBase", null);
        String token = p.getString("token", null);
        if (base == null || token == null) return Result.success();
        long since = p.getLong("since", 0);

        HttpURLConnection conn = null;
        try {
            Uri uri = Uri.parse(base + "/api/push/poll").buildUpon()
                .appendQueryParameter("since", String.valueOf(since))
                .appendQueryParameter("dm", p.getBoolean("dm", true) ? "1" : "0")
                .appendQueryParameter("posts", p.getBoolean("posts", true) ? "1" : "0")
                .appendQueryParameter("interactions", p.getBoolean("interactions", true) ? "1" : "0")
                // 这个版本起有单独的公告通知渠道
                .appendQueryParameter("notice", "1")
                .build();
            boolean debuggable = (ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            if (!"https".equals(uri.getScheme()) && !debuggable) return Result.success();
            conn = (HttpURLConnection) new URL(uri.toString()).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 401) {
                // 登录失效（退出、改密码、被踢下线），停止轮询，等下次登录再开
                p.edit().remove("token").apply();
                cancel(ctx);
                return Result.success();
            }
            if (code < 200 || code >= 300) return Result.success();
            JSONObject d = new JSONObject(read(conn.getInputStream()));
            // 防止两个账号的数据串：取的时候用的 token 已经换掉了就丢弃
            if (!token.equals(p.getString("token", null)) || !base.equals(p.getString("apiBase", null))) return Result.success();
            p.edit().putLong("since", d.getLong("now")).apply();
            if (MainActivity.foreground) return Result.success();
            if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return Result.success();
            }
            JSONArray items = d.optJSONArray("items");
            if (items == null) return Result.success();
            createChannels(ctx);
            NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
            String scope = NotificationOpenActivity.scope(base, token);
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String id = it.getString("id");
                PendingIntent pi = NotificationOpenActivity.pendingIntent(ctx, id, it.optString("path"), scope);
                String body = it.optString("body", "");
                NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, it.optString("kind", "interactions"))
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setColor(0xFF1D9BF0)
                    .setContentTitle(it.optString("title", "校墙"))
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    // 锁屏上不显示私信内容
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPublicVersion(
                        new NotificationCompat.Builder(ctx, it.optString("kind", "interactions"))
                            .setSmallIcon(R.drawable.ic_stat_notify)
                            .setContentTitle("校墙")
                            .setContentText("有新消息")
                            .build()
                    );
                if (!body.isEmpty()) {
                    b.setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body));
                }
                if ("dm".equals(it.optString("kind"))) b.setCategory(NotificationCompat.CATEGORY_MESSAGE);
                nm.notify(id, 1, b.build());
            }
            return Result.success();
        } catch (Exception e) {
            return Result.success();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 1_000_000) throw new java.io.IOException("响应太大");
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
