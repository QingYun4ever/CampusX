package com.tongxuequan.app;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class OfficialAndroidRelease {
    static final String PACKAGE_NAME = "com.tongxuequan.app";
    private static final String REPO = "QingYun4ever/CampusX";
    private static final URI LATEST = URI.create("https://api.github.com/repos/" + REPO + "/releases/latest");
    private static final String ASSETS = "https://github.com/" + REPO + "/releases/download/v";
    // Keep in sync with the release verification in .github/workflows/android-release.yml.
    private static final byte[] SIGNER = decodeHex("c154762c8d441a5e083f9b29c83c6fa02ae520611e2af62b2b38b4f30d392bc2");
    private static final Pattern VERSION = Pattern.compile("[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}");
    private static final Pattern ASSET_DIGEST = Pattern.compile("sha256:([a-fA-F0-9]{64})");
    private static final int MAX_APK_BYTES = 200 * 1024 * 1024;

    final String version;
    final String notes;
    final long size;
    private final String filename;
    private final String assetDigest;
    private final boolean hasSidecar;

    static final class Rejected extends IOException {
        Rejected(String reason) {
            super(reason);
        }
    }

    private OfficialAndroidRelease(String version, String notes, long size, String filename, String assetDigest, boolean hasSidecar) {
        this.version = version;
        this.notes = notes;
        this.size = size;
        this.filename = filename;
        this.assetDigest = assetDigest;
        this.hasSidecar = hasSidecar;
    }

    static OfficialAndroidRelease latest(String currentVersion) throws IOException, JSONException {
        JSONObject release = new JSONObject(fetchText(LATEST, false, 1024 * 1024));
        String tag = release.optString("tag_name");
        if (!tag.startsWith("v") || release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) {
            throw new Rejected("GitHub 没有可验证的正式版本");
        }
        String version = tag.substring(1);
        if (!isNewer(version, currentVersion)) return null;
        String filename = "campusx-android-" + version + ".apk";
        String sidecarName = filename + ".sha256";
        JSONArray assets = release.getJSONArray("assets");
        JSONObject apk = null;
        boolean hasSidecar = false;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!"uploaded".equals(asset.optString("state"))) continue;
            String name = asset.optString("name");
            if (filename.equals(name)) apk = asset;
            if (sidecarName.equals(name)) hasSidecar = true;
        }
        long size = apk == null ? 0 : apk.optLong("size", 0);
        if (size <= 0 || size > MAX_APK_BYTES) throw new Rejected("GitHub 没有有效的官方安装包");
        String notes = release.isNull("body") ? "" : release.optString("body");
        return new OfficialAndroidRelease(version, notes, size, filename, apk.optString("digest"), hasSidecar);
    }

    static boolean isNewer(String version, String current) throws Rejected {
        if (version == null || current == null || !VERSION.matcher(version).matches() || !VERSION.matcher(current).matches()) {
            throw new Rejected("版本号无效，请重新检查更新");
        }
        String[] next = version.split("\\.");
        String[] previous = current.split("\\.");
        for (int i = 0; i < 3; i++) {
            int cmp = Integer.compare(Integer.parseInt(next[i]), Integer.parseInt(previous[i]));
            if (cmp != 0) return cmp > 0;
        }
        return false;
    }

    byte[] expectedDigest() throws IOException {
        Matcher digest = ASSET_DIGEST.matcher(assetDigest);
        if (digest.matches()) return decodeHex(digest.group(1));
        if (hasSidecar) {
            String sidecar = fetchText(assetUri(filename + ".sha256"), true, 512);
            Matcher line = Pattern.compile("([a-fA-F0-9]{64})  " + Pattern.quote(filename) + "\\r?\\n?").matcher(sidecar);
            if (line.matches()) return decodeHex(line.group(1));
        }
        throw new Rejected("GitHub 没有有效的安装包 SHA-256，已停止更新");
    }

    void download(File destination, byte[] expectedDigest) throws IOException {
        MessageDigest digest = sha256();
        HttpsURLConnection conn = connect(assetUri(filename), true);
        long total = 0;
        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(destination)) {
            byte[] chunk = new byte[32 * 1024];
            int n;
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > size) throw new Rejected("安装包大小与 GitHub 发布不符");
                out.write(chunk, 0, n);
                digest.update(chunk, 0, n);
            }
        } finally {
            conn.disconnect();
        }
        if (total != size || !MessageDigest.isEqual(expectedDigest, digest.digest())) {
            throw new Rejected("安装包 SHA-256 校验失败，已停止更新");
        }
    }

    void verifyArchive(PackageManager pm, PackageInfo installed, File file) throws Rejected {
        PackageInfo archive = pm.getPackageArchiveInfo(file.getPath(), signingFlags());
        if (archive == null || !PACKAGE_NAME.equals(archive.packageName) || !version.equals(archive.versionName)
            || versionCode(archive) <= versionCode(installed) || archive.applicationInfo == null
            || (archive.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            throw new Rejected("安装包的应用标识或版本不符，已停止更新");
        }
        if (archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) {
            throw new Rejected("此更新与当前 Android 版本不兼容");
        }
        if (!hasReleaseSigner(archive)) throw new Rejected("安装包不是官方签名，已停止更新");
    }

    static int signingFlags() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    static boolean hasReleaseSigner(PackageInfo info) {
        Signature[] signers;
        if (Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) return false;
            signers = info.signingInfo.getApkContentsSigners();
        } else {
            signers = info.signatures;
        }
        return signers != null && signers.length == 1
            && MessageDigest.isEqual(SIGNER, sha256().digest(signers[0].toByteArray()));
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private URI assetUri(String name) {
        // Do not use browser_download_url or other URLs from the release payload.
        return URI.create(ASSETS + version + "/" + name);
    }

    private static String fetchText(URI uri, boolean asset, int limit) throws IOException {
        HttpsURLConnection conn = connect(uri, asset);
        try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[Math.min(8192, limit)];
            int n;
            while ((n = in.read(chunk)) != -1) {
                if (out.size() + n > limit) throw new Rejected("GitHub 发布信息大小异常");
                out.write(chunk, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            conn.disconnect();
        }
    }

    private static HttpsURLConnection connect(URI uri, boolean asset) throws IOException {
        for (int hops = 0; ; hops++) {
            String host = uri.getHost();
            boolean allowedHost = !asset ? "api.github.com".equalsIgnoreCase(host)
                : hops == 0 ? "github.com".equalsIgnoreCase(host)
                : "release-assets.githubusercontent.com".equalsIgnoreCase(host) || "objects.githubusercontent.com".equalsIgnoreCase(host);
            if (!allowedHost || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
                || uri.getRawFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) {
                throw new Rejected("GitHub 下载跳转到不受信任的地址，已停止更新");
            }
            HttpsURLConnection conn = (HttpsURLConnection) uri.toURL().openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", "CampusX-Android");
            if (!asset) conn.setRequestProperty("Accept", "application/vnd.github+json");
            boolean keep = false;
            try {
                int status = conn.getResponseCode();
                if (status == 200) {
                    keep = true;
                    return conn;
                }
                String location = conn.getHeaderField("Location");
                if (!asset || hops >= 3 || location == null
                    || (status != 301 && status != 302 && status != 303 && status != 307 && status != 308)) {
                    throw new Rejected("GitHub 暂时无法提供更新（HTTP " + status + "）");
                }
                try {
                    uri = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    throw new Rejected("GitHub 下载跳转地址无效");
                }
            } finally {
                if (!keep) conn.disconnect();
            }
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] decodeHex(String hex) {
        byte[] result = new byte[hex.length() / 2];
        for (int i = 0; i < result.length; i++) {
            result[i] = (byte) ((Character.digit(hex.charAt(i * 2), 16) << 4) | Character.digit(hex.charAt(i * 2 + 1), 16));
        }
        return result;
    }
}
