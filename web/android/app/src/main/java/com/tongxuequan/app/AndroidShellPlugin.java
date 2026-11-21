package com.tongxuequan.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.view.Window;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidShell")
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
}
