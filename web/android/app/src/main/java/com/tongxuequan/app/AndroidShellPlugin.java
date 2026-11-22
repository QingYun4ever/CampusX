package com.tongxuequan.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Window;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(
    name = "AndroidShell",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
        // 只有 Android 9 及以下保存图片到相册需要
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage"),
    }
)
public class AndroidShellPlugin extends Plugin {
    @PluginMethod
    public void openBrowser(PluginCall call) {
        String value = call.getString("url");
        Uri uri = value == null ? Uri.EMPTY : Uri.parse(value);
        String scheme = uri.getScheme();
        if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null || uri.getHost().isEmpty()) {
            call.reject("只支持 HTTP 或 HTTPS 链接");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        // 只匹配浏览器，不让关联了这个域名的其他 App 接管网页链接。
        intent.setSelector(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("没有可用的系统浏览器");
            }
        });
    }

    @PluginMethod
    public void setBackdrop(PluginCall call) {
        String value = call.getString("color");
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            call.reject("应使用 #RRGGBB 颜色");
            return;
        }
        int color = Color.parseColor(value);
        // 旧版 WebView 的安全区由原生窗口留白，Web CSS 不会画到这部分。
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            window.setBackgroundDrawable(new ColorDrawable(color));
            window.getDecorView().requestApplyInsets();
            call.resolve();
        });
    }

    /** 用系统的「另存为」让用户自己选位置，不需要存储权限 */
    @PluginMethod
    public void saveText(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty() || call.getString("text") == null) {
            call.reject("缺少文件名或内容");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saveTextResult");
    }

    @ActivityCallback
    private void saveTextResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("已取消");
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(data.getData(), "wt")) {
            if (out == null) throw new IOException("无法写入");
            out.write(("\ufeff" + call.getString("text")).getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException e) {
            call.reject("保存失败");
        }
    }

    /* ---------------- 保存图片到相册 ---------------- */

    private static final int MAX_IMAGE_BYTES = 40 * 1024 * 1024;

    /** url：http(s) 图片地址，由原生下载；data：base64（私信图片这类只在页面里有的 blob） */
    @PluginMethod
    public void saveImage(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionResult");
            return;
        }
        new Thread(() -> doSaveImage(call)).start();
    }

    @PermissionCallback
    private void storagePermissionResult(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("需要存储权限才能保存图片");
            return;
        }
        new Thread(() -> doSaveImage(call)).start();
    }

    private void doSaveImage(PluginCall call) {
        try {
            byte[] bytes;
            String mime = call.getString("mime");
            String data = call.getString("data");
            if (data != null) {
                bytes = Base64.decode(data, Base64.DEFAULT);
            } else {
                String value = call.getString("url");
                Uri uri = value == null ? Uri.EMPTY : Uri.parse(value);
                if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) {
                    call.reject("图片地址无效");
                    return;
                }
                HttpURLConnection conn = (HttpURLConnection) new URL(value).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                try {
                    if (conn.getResponseCode() != 200) throw new IOException("HTTP " + conn.getResponseCode());
                    if (mime == null) mime = conn.getContentType();
                    try (InputStream in = conn.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                        byte[] chunk = new byte[16384];
                        int n;
                        while ((n = in.read(chunk)) > 0) {
                            buf.write(chunk, 0, n);
                            if (buf.size() > MAX_IMAGE_BYTES) throw new IOException("too large");
                        }
                        bytes = buf.toByteArray();
                    }
                } finally {
                    conn.disconnect();
                }
            }
            if (mime == null || !mime.startsWith("image/")) mime = "image/jpeg";
            mime = mime.split(";")[0].trim();
            String ext = mime.equals("image/png") ? "png" : mime.equals("image/webp") ? "webp" : mime.equals("image/gif") ? "gif" : "jpg";
            String name = "campusx_" + System.currentTimeMillis() + "." + ext;
            writeToGallery(bytes, name, mime);
            call.resolve();
        } catch (Exception e) {
            call.reject("保存失败，请检查网络后再试");
        }
    }

    private void writeToGallery(byte[] bytes, String name, String mime) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Images.Media.MIME_TYPE, mime);
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/校墙");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri item = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (item == null) throw new IOException("insert failed");
            try (OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IOException("no stream");
                out.write(bytes);
            } catch (IOException e) {
                resolver.delete(item, null, null);
                throw e;
            }
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(item, values, null, null);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "校墙");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir failed");
            File file = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { mime }, null);
        }
    }

    /* ---------------- 通知 ---------------- */

    private boolean notificationsAllowed() {
        boolean perm = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
        return perm && NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    private void resolvePermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", notificationsAllowed());
        // 已经被拒绝过、系统不再弹窗：只能去系统设置里开
        r.put("canAsk", Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.DENIED);
        call.resolve(r);
    }

    @PluginMethod
    public void checkNotifications(PluginCall call) {
        resolvePermission(call);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
            return;
        }
        resolvePermission(call);
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        resolvePermission(call);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("打不开系统设置");
        }
    }

    /** 保存推送设置。token 为空表示关闭推送（退出登录、或者用户关掉了） */
    @PluginMethod
    public void configurePush(PluginCall call) {
        String apiBase = call.getString("apiBase");
        String token = call.getString("token");
        android.content.SharedPreferences p = PushWorker.prefs(getContext());
        if (apiBase == null || token == null || token.isEmpty() || !Boolean.TRUE.equals(call.getBoolean("enabled", false))) {
            p.edit().remove("token").apply();
            PushWorker.cancel(getContext());
            call.resolve();
            return;
        }
        android.content.SharedPreferences.Editor e = p.edit();
        // 换了账号或服务器就从现在开始算，不补推旧消息
        if (!token.equals(p.getString("token", null)) || !apiBase.equals(p.getString("apiBase", null))) e.putLong("since", 0);
        e.putString("apiBase", apiBase)
            .putString("token", token)
            .putBoolean("dm", call.getBoolean("dm", true))
            .putBoolean("posts", call.getBoolean("posts", true))
            .putBoolean("interactions", call.getBoolean("interactions", true))
            .apply();
        PushWorker.createChannels(getContext());
        PushWorker.schedule(getContext());
        call.resolve();
    }

    /** 点了通知：让网页跳到对应页面。网页还没加载好时事件会先留着 */
    public void openPath(String path) {
        JSObject d = new JSObject();
        d.put("path", path);
        notifyListeners("openPath", d, true);
    }
}
