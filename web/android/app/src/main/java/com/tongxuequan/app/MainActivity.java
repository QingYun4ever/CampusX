package com.tongxuequan.app;

import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
    }
}
