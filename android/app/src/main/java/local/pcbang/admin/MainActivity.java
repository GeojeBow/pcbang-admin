package local.pcbang.admin;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 관리자 웹앱(GitHub Pages)을 그대로 띄우는 앱.
 * 화면은 웹에서 불러오므로 웹을 고치면 앱도 자동으로 바뀐다.
 * 앱을 닫아도 주문/호출 알림은 AlertService가 받는다.
 */
public class MainActivity extends Activity {
    static volatile boolean visible = false;
    private static final int FILE_REQUEST = 10;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0f172a"));

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " PCBangApp/" + BuildConfig.VERSION_CODE);
        web.addJavascriptInterface(new Bridge(), "PCBangApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (BuildConfig.ADMIN_URL.startsWith(u.getScheme() + "://" + u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // 다른 주소는 브라우저로
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.ADMIN_URL);

        askNotificationPermission();
        AlertService.startIfReady(this);
        Updater.check(this);
    }

    @Override protected void onResume() { super.onResume(); visible = true; AlertService.clearAlerts(this); }
    @Override protected void onPause() { super.onPause(); visible = false; }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // 앱을 끄지 않고 뒤로 보낸다
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** 배터리 최적화에서 빼야 화면이 꺼져 있어도 알림이 늦지 않는다 (한 번만 물어본다) */
    private void askBatteryExemption() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        SharedPreferences p = getSharedPreferences("app", MODE_PRIVATE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName()) || p.getBoolean("askedBattery", false)) return;
        p.edit().putBoolean("askedBattery", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("알림이 늦지 않게 하기")
                .setMessage("핸드폰 화면이 꺼져 있어도 주문/호출 알림을 바로 받으려면 다음 화면에서 '허용'을 눌러 주세요.")
                .setPositiveButton("다음", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                    } catch (Exception ignored) { }
                })
                .setNegativeButton("나중에", null)
                .show();
    }

    /** 웹 화면에서 부르는 기능 */
    private class Bridge {
        @JavascriptInterface public int version() { return BuildConfig.VERSION_CODE; }

        @JavascriptInterface public boolean hasAlerts() { return AlertService.hasCredentials(MainActivity.this); }

        /** 로그인할 때 한 번 받아서 알림 전용 로그인을 따로 만든다. 비밀번호는 저장하지 않는다. */
        @JavascriptInterface
        public void login(String url, String key, String email, String password) {
            new Thread(() -> {
                try {
                    JSONObject body = new JSONObject().put("email", email).put("password", password);
                    JSONObject res = Api.post(url + "/auth/v1/token?grant_type=password", key, null, body);
                    AlertService.saveSession(MainActivity.this, url, key, res);
                    AlertService.startIfReady(MainActivity.this);
                    runOnUiThread(MainActivity.this::askBatteryExemption);
                } catch (Exception e) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "알림 연결 실패: " + e.getMessage(), Toast.LENGTH_LONG).show());
                }
            }).start();
        }

        @JavascriptInterface
        public void logout() {
            AlertService.clearSession(MainActivity.this);
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                startActivity(i);
            });
        }
    }
}
