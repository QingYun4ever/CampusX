package com.tongxuequan.app;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "AndroidUpdates")
public class AndroidUpdatesPlugin extends Plugin {
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private final AtomicBoolean installing = new AtomicBoolean();
    // Only the UI thread owns the file once it has been passed to the installer.
    private File installerFile;
    private Uri installerUri;

    /** 同时给每条线路测速，返回 [{url, speed}]，speed 是字节/秒，-1 表示不可用 */
    @PluginMethod
    public void probeMirrors(PluginCall call) {
        JSArray list = call.getArray("urls");
        int bytes = Math.max(16 * 1024, Math.min(1024 * 1024, call.getData().optInt("bytes", 256 * 1024)));
        int timeout = Math.max(2000, Math.min(20000, call.getData().optInt("timeoutMs", 8000)));
        List<String> urls = new ArrayList<>();
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                String url = list.optString(i, "");
                if (url.startsWith("https://")) urls.add(url);
            }
        }
        if (urls.isEmpty()) {
            call.reject("没有可测速的线路");
            return;
        }
        new Thread(() -> {
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(urls.size(), 6));
            try {
                List<Future<Long>> jobs = new ArrayList<>();
                for (String url : urls) jobs.add(pool.submit(() -> OfficialAndroidRelease.probe(url, bytes, timeout)));
                JSArray results = new JSArray();
                for (int i = 0; i < urls.size(); i++) {
                    long speed;
                    try {
                        speed = jobs.get(i).get(timeout + 3000L, TimeUnit.MILLISECONDS);
                    } catch (Exception e) {
                        speed = -1;
                    }
                    JSObject r = new JSObject();
                    r.put("url", urls.get(i));
                    r.put("speed", speed);
                    results.put(r);
                }
                JSObject out = new JSObject();
                out.put("results", results);
                call.resolve(out);
            } finally {
                pool.shutdownNow();
            }
        }, "campusx-mirror-probe").start();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        if (!installing.compareAndSet(false, true)) {
            call.reject("正在处理另一项更新");
            return;
        }
        try {
            PackageInfo installed = verifyUpdateRequest(call);
            if (installAllowed()) {
                downloadAndInstall(call, installed);
                return;
            }
        } catch (OfficialAndroidRelease.Rejected e) {
            fail(call, e.getMessage());
            return;
        } catch (Exception e) {
            fail(call, "无法确认 Android 安装权限");
            return;
        }
        Intent settings = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", getContext().getPackageName(), null))
            : new Intent(Settings.ACTION_SECURITY_SETTINGS);
        getActivity().runOnUiThread(() -> {
            try {
                restrictToSystem(settings, false);
                startActivityForResult(call, settings, "unknownSourcesResult");
            } catch (RuntimeException | OfficialAndroidRelease.Rejected e) {
                fail(call, "无法打开系统安装权限设置");
            }
        });
    }

    @ActivityCallback
    private void unknownSourcesResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            installing.set(false);
            return;
        }
        installing.set(true);
        try {
            // The Settings activity does not reliably report whether permission was granted in its result.
            if (!installAllowed()) {
                fail(call, "未允许安装未知应用，已停止更新");
                return;
            }
            downloadAndInstall(call, verifyUpdateRequest(call));
        } catch (OfficialAndroidRelease.Rejected e) {
            fail(call, e.getMessage());
        } catch (Exception e) {
            fail(call, "无法确认 Android 安装权限");
        }
    }

    private void downloadAndInstall(PluginCall call, PackageInfo installed) {
        new Thread(() -> {
            File apk = null;
            try {
                cleanCache(installed.lastUpdateTime);
                OfficialAndroidRelease release = new OfficialAndroidRelease(
                    call.getString("version"),
                    // 不能用 call.getLong：JSON 里小于 2^31 的数会被解析成 Integer，getLong 会直接返回默认值 0
                    call.getData().optLong("size", 0L),
                    call.getString("sha256")
                );
                List<String> urls = new ArrayList<>();
                JSArray list = call.getArray("urls");
                if (list != null) {
                    for (int i = 0; i < list.length(); i++) {
                        String url = list.optString(i, "");
                        if (url.startsWith("https://")) urls.add(url);
                    }
                }
                if (urls.isEmpty()) throw new OfficialAndroidRelease.Rejected("没有可用的下载线路");
                File cache = cacheDirectory();
                if (!cache.isDirectory() && !cache.mkdirs() && !cache.isDirectory()) throw new IOException("cache directory");
                apk = File.createTempFile("campusx-", ".apk", cache);
                release.download(apk, urls);
                release.verifyArchive(getContext().getPackageManager(), installed, apk);
                File verified = apk;
                getActivity().runOnUiThread(() -> handOffToInstaller(call, verified));
                apk = null; // Ownership passed to the UI thread.
            } catch (OfficialAndroidRelease.Rejected e) {
                fail(call, e.getMessage());
            } catch (Exception e) {
                fail(call, "所有下载线路都失败了，请检查网络后再试，或改用浏览器下载");
            } finally {
                if (apk != null) apk.delete();
            }
        }, "campusx-update-download").start();
    }

    private void handOffToInstaller(PluginCall call, File verified) {
        installerFile = verified;
        try {
            if (!MainActivity.foreground || getActivity().isFinishing() || getActivity().isDestroyed()) {
                throw new OfficialAndroidRelease.Rejected("请回到校墙重新开始安装");
            }
            if (!installAllowed()) throw new OfficialAndroidRelease.Rejected("未允许安装未知应用，已停止更新");
            Context context = getContext();
            installerUri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", verified);
            Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                .setDataAndType(installerUri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .putExtra(Intent.EXTRA_RETURN_RESULT, true);
            restrictToSystem(install, true);
            startActivityForResult(call, install, "installerResult");
        } catch (OfficialAndroidRelease.Rejected e) {
            releaseInstallerFile();
            fail(call, e.getMessage());
        } catch (RuntimeException e) {
            releaseInstallerFile();
            fail(call, "无法打开 Android 安装器");
        }
    }

    @ActivityCallback
    private void installerResult(PluginCall call, ActivityResult result) {
        releaseInstallerFile();
        installing.set(false);
        if (call == null) return;
        int code = result.getResultCode();
        if (code == Activity.RESULT_OK || code == Activity.RESULT_CANCELED) {
            JSObject data = new JSObject();
            data.put("installed", code == Activity.RESULT_OK);
            call.resolve(data);
        } else {
            call.reject("Android 未能安装更新");
        }
    }

    private PackageInfo verifyUpdateRequest(PluginCall call) throws PackageManager.NameNotFoundException, OfficialAndroidRelease.Rejected {
        PackageInfo installed = installedPackage(OfficialAndroidRelease.signingFlags());
        if (!OfficialAndroidRelease.hasReleaseSigner(installed)) {
            throw new OfficialAndroidRelease.Rejected("当前应用不是官方签名，无法覆盖更新");
        }
        if (!OfficialAndroidRelease.isNewer(call.getString("version"), installed.versionName)) {
            throw new OfficialAndroidRelease.Rejected("只能安装比当前版本更新的官方版本");
        }
        return installed;
    }

    private PackageInfo installedPackage(int flags) throws PackageManager.NameNotFoundException, OfficialAndroidRelease.Rejected {
        Context context = getContext();
        String name = context.getPackageName();
        if (!OfficialAndroidRelease.PACKAGE_NAME.equals(name)) {
            throw new OfficialAndroidRelease.Rejected("当前不是受支持的校墙应用");
        }
        return context.getPackageManager().getPackageInfo(name, flags);
    }

    private boolean installAllowed() {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return context.getPackageManager().canRequestPackageInstalls();
        return Settings.Secure.getInt(context.getContentResolver(), Settings.Secure.INSTALL_NON_MARKET_APPS, 0) == 1;
    }

    private void restrictToSystem(Intent intent, boolean installer) throws OfficialAndroidRelease.Rejected {
        PackageManager pm = getContext().getPackageManager();
        for (ResolveInfo match : pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY)) {
            ActivityInfo info = match.activityInfo;
            if (info == null || !info.exported) continue;
            if (installer && pm.checkPermission(Manifest.permission.INSTALL_PACKAGES, info.packageName) != PackageManager.PERMISSION_GRANTED) {
                continue;
            }
            intent.setComponent(new ComponentName(info.packageName, info.name));
            return;
        }
        throw new OfficialAndroidRelease.Rejected(installer ? "没有可用的 Android 安装器" : "无法打开系统安装权限设置");
    }

    private File cacheDirectory() {
        return new File(getContext().getCacheDir(), "android-updates");
    }

    private void releaseInstallerFile() {
        if (installerUri != null) getContext().revokeUriPermission(installerUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (installerFile != null) installerFile.delete();
        installerUri = null;
        installerFile = null;
    }

    private void cleanCache(long lastUpdateTime) {
        // Android can kill this process when the app replaces itself, before the Activity result arrives.
        long cutoff = Math.max(lastUpdateTime, System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1));
        File[] files = cacheDirectory().listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.lastModified() < cutoff) file.delete();
        }
    }

    private void fail(PluginCall call, String reason) {
        installing.set(false);
        call.reject(reason);
    }
}
