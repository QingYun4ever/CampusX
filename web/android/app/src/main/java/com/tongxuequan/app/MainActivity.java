package com.tongxuequan.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    static final String EXTRA_PATH = "campus_path";
    /** App 在前台时后台轮询不弹通知，看到的就是最新的 */
    static volatile boolean foreground = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(AndroidShellPlugin.class);
        super.onCreate(savedInstanceState);

        WindowCompat.enableEdgeToEdge(getWindow());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Android 7.0/7.1 的导航键只能用浅色。
            getWindow().setNavigationBarColor(Color.BLACK);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(true);
        }

        if (getBridge() != null && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            // 只有可调试安装包能从 https://localhost 请求调试用 HTTP 后端。
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        openFromIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    public void onPause() {
        foreground = false;
        super.onPause();
    }

    private void openFromIntent(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra(EXTRA_PATH);
        // 只接受站内路径
        if (path == null || !path.startsWith("/") || path.startsWith("//")) return;
        intent.removeExtra(EXTRA_PATH);
        PluginHandle h = getBridge() == null ? null : getBridge().getPlugin("AndroidShell");
        if (h != null) ((AndroidShellPlugin) h.getInstance()).openPath(path);
    }
}
