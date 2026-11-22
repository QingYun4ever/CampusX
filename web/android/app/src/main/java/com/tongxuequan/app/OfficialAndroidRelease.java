package com.tongxuequan.app;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 一次更新：版本号、大小、SHA-256 来自自己的服务器（服务器缓存 GitHub Releases 的信息），
 * 安装包可以从加速镜像下载。装之前核对 SHA-256、包名、版本号和官方签名证书，
 * 所以镜像或网络中间人改不了安装包。
 */
final class OfficialAndroidRelease {
    static final String PACKAGE_NAME = "com.tongxuequan.app";
    // Keep in sync with the release verification in .github/workflows/android-release.yml.
    private static final byte[] SIGNER = decodeHex("c154762c8d441a5e083f9b29c83c6fa02ae520611e2af62b2b38b4f30d392bc2");
    private static final Pattern VERSION = Pattern.compile("[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}");
    private static final Pattern HEX64 = Pattern.compile("[a-fA-F0-9]{64}");
    private static final long MAX_APK_BYTES = 200L * 1024 * 1024;

    final String version;
    final long size;
    private final byte[] digest;

    static final class Rejected extends IOException {
        Rejected(String reason) {
            super(reason);
        }
    }

    OfficialAndroidRelease(String version, long size, String sha256) throws Rejected {
        if (version == null || !VERSION.matcher(version).matches()) throw new Rejected("版本号无效，请重新检查更新");
        if (size <= 0 || size > MAX_APK_BYTES) throw new Rejected("安装包大小无效，请重新检查更新");
        if (sha256 == null || !HEX64.matcher(sha256).matches()) throw new Rejected("服务器没有提供安装包的 SHA-256，请稍后再试");
        this.version = version;
        this.size = size;
        this.digest = decodeHex(sha256.toLowerCase());
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

    /** 按顺序试每条线路（加速镜像在前），第一个下载完整且 SHA-256 对得上的就用它 */
    void download(File destination, List<String> urls) throws IOException {
        Rejected lastRejected = null;
        for (String url : urls) {
            try {
                downloadFrom(URI.create(url), destination);
                return;
            } catch (Rejected e) {
                lastRejected = e;
            } catch (IOException | IllegalArgumentException e) {
                // 这条线路不通，换下一条
            }
        }
        if (lastRejected != null) throw lastRejected;
        throw new IOException("all mirrors failed");
    }

    private void downloadFrom(URI uri, File destination) throws IOException {
        MessageDigest sha = sha256();
        HttpURLConnection conn = connect(uri);
        long total = 0;
        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(destination)) {
            byte[] chunk = new byte[32 * 1024];
            int n;
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > size) throw new Rejected("安装包大小不符，已停止更新");
                out.write(chunk, 0, n);
                sha.update(chunk, 0, n);
            }
        } finally {
            conn.disconnect();
        }
        if (total != size || !MessageDigest.isEqual(digest, sha.digest())) {
            throw new Rejected("安装包 SHA-256 校验失败，已停止更新");
        }
    }

    /** 只走 https，最多跟随 5 次跳转（镜像和 GitHub 都会跳到 CDN） */
    private static HttpURLConnection connect(URI uri) throws IOException {
        for (int hops = 0; ; hops++) {
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null) {
                throw new IOException("only https");
            }
            HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", "CampusX-Android");
            boolean keep = false;
            try {
                int status = conn.getResponseCode();
                if (status == 200) {
                    keep = true;
                    return conn;
                }
                String location = conn.getHeaderField("Location");
                if (hops >= 5 || location == null || status < 300 || status > 399) throw new IOException("HTTP " + status);
                uri = uri.resolve(location);
            } finally {
                if (!keep) conn.disconnect();
            }
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
