package com.tongxuequan.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.view.Window;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

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
}
