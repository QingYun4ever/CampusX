package com.tongxuequan.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/** Only a notification's PendingIntent can reach this private entry point from outside the app. */
public class NotificationOpenActivity extends Activity {
    private static final String EXTRA_PATH = "campus_path";
    private static final Pattern ROUTE = Pattern.compile(
        "/notifications|/\\?tab=following|/post/[1-9][0-9]{0,18}|/messages/[A-Za-z0-9_]{3,20}"
    );
    private static final AtomicReference<Destination> pending = new AtomicReference<>();

    private static final class Destination {
        final String path;
        final String scope;

        Destination(String path, String scope) {
            this.path = path;
            this.scope = scope;
        }
    }

    // Bind a notification to the server and login that produced it, without putting the token in the Intent.
    static String scope(String base, String token) {
        if (base == null || token == null || token.isEmpty()) return null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(base.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            return Base64.encodeToString(
                digest.digest(token.getBytes(StandardCharsets.UTF_8)),
                Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP
            );
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static PendingIntent pendingIntent(Context ctx, String id, String path, String scope) {
        Uri data = new Uri.Builder().scheme("campus-notification").authority(scope).appendPath(id).build();
        Intent open = new Intent(ctx, NotificationOpenActivity.class)
            .setData(data)
            .putExtra(EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(
            ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT
        );
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        Uri data = intent.getData();
        String path = intent.getStringExtra(EXTRA_PATH);
        String scope = data == null ? null : data.getAuthority();
        SharedPreferences prefs = PushWorker.prefs(this);
        if (scope != null && scope.equals(scope(prefs.getString("apiBase", null), prefs.getString("token", null)))
            && path != null && ROUTE.matcher(path).matches()) {
            pending.set(new Destination(path, scope));
        }
        // The exported launcher only opens the UI. Never pass any routing data to it.
        startActivity(new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }

    static boolean hasPendingDestination() {
        return pending.get() != null;
    }

    static String takePath(String base, String token) {
        Destination destination = pending.getAndSet(null);
        return destination != null && destination.scope.equals(scope(base, token)) ? destination.path : null;
    }
}
