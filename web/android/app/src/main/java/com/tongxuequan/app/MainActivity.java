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
    /** App 在前台时后台轮询不弹通知，看到的就是最新的 */
    static volatile boolean foreground = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The exported launcher is only an entry point. Do not forward public URI data or extras to Capacitor.
        setIntent(new Intent(Intent.ACTION_MAIN));
        SplashScreen.installSplashScreen(this);
        registerPlugin(AndroidShellPlugin.class);
        registerPlugin(AndroidUpdatesPlugin.class);
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
    }

    @Override
    protected void onNewIntent(Intent ignored) {
        super.onNewIntent(new Intent(Intent.ACTION_MAIN));
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
        if (NotificationOpenActivity.hasPendingDestination() && getBridge() != null) {
            PluginHandle h = getBridge().getPlugin("AndroidShell");
            if (h != null) ((AndroidShellPlugin) h.getInstance()).signalNotificationOpened();
        }
    }

    @Override
    public void onPause() {
        foreground = false;
        super.onPause();
    }
}
