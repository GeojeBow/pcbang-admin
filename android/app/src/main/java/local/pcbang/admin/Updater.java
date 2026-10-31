package local.pcbang.admin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

/** 앱 껍데기 자체의 새 버전 확인 (화면은 웹이라 항상 최신). 새 APK가 있으면 받을지 물어본다. */
class Updater {
    static void check(Activity a) {
        new Thread(() -> {
            try {
                JSONObject rel = new JSONObject(Api.request("GET", BuildConfig.RELEASE_API, null, null, null));
                String tag = rel.optString("tag_name", "");           // 예: android-12
                if (!tag.startsWith("android-")) return;
                int latest = Integer.parseInt(tag.substring("android-".length()));
                if (latest <= BuildConfig.VERSION_CODE) return;
                String apk = null;
                JSONArray assets = rel.optJSONArray("assets");
                for (int i = 0; assets != null && i < assets.length(); i++) {
                    JSONObject as = assets.getJSONObject(i);
                    if (as.optString("name").endsWith(".apk")) apk = as.optString("browser_download_url");
                }
                if (apk == null) return;
                final String url = apk;
                a.runOnUiThread(() -> new AlertDialog.Builder(a)
                        .setTitle("앱 새 버전이 있어요")
                        .setMessage("새 버전을 받아서 설치할까요? 받은 파일을 열고 '업데이트'를 누르면 됩니다.")
                        .setPositiveButton("받기", (d, w) -> a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))))
                        .setNegativeButton("나중에", null)
                        .show());
            } catch (Exception ignored) { }
        }).start();
    }
}
