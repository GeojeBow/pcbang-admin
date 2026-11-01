package local.pcbang.admin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 앱을 닫아도 15초마다 Supabase에서 새 주문/채팅/호출/시간 종료를 확인해서 알림을 띄운다.
 * 관리자 웹앱과는 별도의 로그인 세션(refresh token)을 쓴다.
 */
public class AlertService extends Service {
    private static final String CH_STATUS = "status";
    private static final String CH_ALERT = "alerts";
    private static final int STATUS_ID = 1;
    private static int alertId = 100;

    private ScheduledExecutorService timer;
    private long lastOrder = -1, lastMsg = -1;
    private final Map<String, String> seatNames = new HashMap<>();
    private final Map<String, Boolean> seatTimedOut = new HashMap<>();
    // 비정상 종료 감지: last_seen 값이 바뀐 마지막 시각(핸드폰 시계 기준, PC 시계가 틀려도 됨)
    private final Map<String, String> seatLastSeen = new HashMap<>();
    private final Map<String, Long> seatSeenChangedAt = new HashMap<>();
    private final Map<String, Boolean> seatInUse = new HashMap<>();
    private boolean seatsLoaded = false;

    // ---------- 세션 저장 ----------
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("alerts", MODE_PRIVATE); }

    static boolean hasCredentials(Context c) { return prefs(c).getString("refresh", null) != null; }

    static void saveSession(Context c, String url, String key, JSONObject tok) throws Exception {
        prefs(c).edit()
                .putString("url", url).putString("key", key)
                .putString("access", tok.getString("access_token"))
                .putString("refresh", tok.getString("refresh_token"))
                .putLong("expires", System.currentTimeMillis() + tok.optLong("expires_in", 3600) * 1000L)
                .apply();
    }

    static void clearSession(Context c) {
        prefs(c).edit().clear().apply();
        c.stopService(new Intent(c, AlertService.class));
    }

    static void startIfReady(Context c) {
        if (!hasCredentials(c)) return;
        try {
            Intent i = new Intent(c, AlertService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception ignored) { }
    }

    static void clearAlerts(Context c) {
        ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).cancelAll();
        startIfReady(c); // 상태 알림은 다시 띄운다
    }

    // ---------- 서비스 ----------
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel status = new NotificationChannel(CH_STATUS, "알림 대기 중 표시", NotificationManager.IMPORTANCE_MIN);
        status.setShowBadge(false);
        nm.createNotificationChannel(status);
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "주문 · 채팅 · 호출", NotificationManager.IMPORTANCE_HIGH);
        alert.enableVibration(true);
        alert.setVibrationPattern(new long[]{0, 250, 120, 250});
        nm.createNotificationChannel(alert);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, CH_STATUS)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("PC방 알림 대기 중")
                .setContentText("새 주문과 호출을 알려 드려요")
                .setContentIntent(openApp())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(STATUS_ID, n);

        if (timer == null) {
            timer = Executors.newSingleThreadScheduledExecutor();
            timer.scheduleWithFixedDelay(this::pollSafe, 0, 15, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (timer != null) timer.shutdownNow();
        timer = null;
        super.onDestroy();
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void alert(String title, String text) {
        if (MainActivity.visible) return; // 앱 화면을 보고 있으면 화면 안에서 알려준다
        Notification n = new Notification.Builder(this, CH_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(alertId++, n);
    }

    // ---------- 확인 ----------
    static class SessionExpired extends Exception { }

    private void pollSafe() {
        try {
            poll();
        } catch (SessionExpired e) {
            expired();
        } catch (Api.HttpError e) {
            if (e.code == 401 && !refresh()) expired();
        } catch (Exception ignored) { /* 네트워크 오류는 다음 번에 다시 */ }
    }

    private void expired() {
        MainActivity.visible = false;
        alert("PC방 알림이 멈췄어요", "앱을 열어 로그아웃 후 다시 로그인해 주세요.");
        clearSession(this);
    }

    private String token() throws Exception {
        SharedPreferences p = prefs(this);
        if (System.currentTimeMillis() > p.getLong("expires", 0) - 120_000) {
            if (!refresh()) throw new SessionExpired();
        }
        return p.getString("access", null);
    }

    private boolean refresh() {
        SharedPreferences p = prefs(this);
        try {
            JSONObject body = new JSONObject().put("refresh_token", p.getString("refresh", ""));
            JSONObject res = Api.post(p.getString("url", "") + "/auth/v1/token?grant_type=refresh_token", p.getString("key", ""), null, body);
            saveSession(this, p.getString("url", ""), p.getString("key", ""), res);
            return true;
        } catch (Api.HttpError e) {
            return false;
        } catch (Exception e) {
            return true; // 네트워크 문제면 세션은 그대로 두고 다음에 다시
        }
    }

    private void poll() throws Exception {
        SharedPreferences p = prefs(this);
        String base = p.getString("url", "") + "/rest/v1/";
        String key = p.getString("key", "");
        String tok = token();

        // 좌석 이름과 시간 종료
        JSONArray seats = Api.getArray(base + "seats?select=id,name,locked,mode,remaining_sec,online,last_seen", key, tok);
        for (int i = 0; i < seats.length(); i++) {
            JSONObject s = seats.getJSONObject(i);
            String id = s.getString("id");
            seatNames.put(id, s.optString("name"));
            boolean out = s.optBoolean("locked") && "timed".equals(s.optString("mode")) && s.optInt("remaining_sec") == 0;
            Boolean before = seatTimedOut.put(id, out);
            if (seatsLoaded && out && Boolean.FALSE.equals(before)) alert("⏰ 시간 종료", s.optString("name") + " 사용 시간이 끝나 잠겼어요.");

            // 사용 중이던 PC가 정상 종료 기록 없이 1분 넘게 소식이 없으면 알림
            long now = System.currentTimeMillis();
            String seen = s.optString("last_seen", "");
            if (!seatLastSeen.containsKey(id)) { seatLastSeen.put(id, seen); seatSeenChangedAt.put(id, 0L); } // 처음 본 값은 살아 있다는 증거가 아님
            else if (!seen.equals(seatLastSeen.get(id))) { seatLastSeen.put(id, seen); seatSeenChangedAt.put(id, now); }
            Long changed = seatSeenChangedAt.get(id);
            boolean alive = s.optBoolean("online") && changed != null && now - changed < 60_000;
            boolean inUse = alive && !s.optBoolean("locked");
            if (seatsLoaded && Boolean.TRUE.equals(seatInUse.get(id)) && !alive && s.optBoolean("online")) {
                alert("⚠️ " + s.optString("name") + " 연결 끊김", "사용 중이던 PC의 연결이 갑자기 끊겼어요. 프로그램 강제 종료, 전원 또는 인터넷 문제일 수 있어요.");
            }
            seatInUse.put(id, inUse);
        }
        seatsLoaded = true;

        // 처음에는 기준 번호만 잡는다 (예전 것까지 알리지 않게)
        if (lastOrder < 0) lastOrder = maxId(base + "orders?select=id&order=id.desc&limit=1", key, tok);
        if (lastMsg < 0) lastMsg = maxId(base + "messages?select=id&order=id.desc&limit=1", key, tok);

        JSONArray orders = Api.getArray(base + "orders?select=id,seat_name,items,total,note&order=id.asc&id=gt." + lastOrder, key, tok);
        for (int i = 0; i < orders.length(); i++) {
            JSONObject o = orders.getJSONObject(i);
            lastOrder = Math.max(lastOrder, o.getLong("id"));
            StringBuilder sb = new StringBuilder();
            JSONArray items = o.optJSONArray("items");
            for (int j = 0; items != null && j < items.length(); j++) {
                JSONObject it = items.getJSONObject(j);
                if (sb.length() > 0) sb.append(", ");
                sb.append(it.optString("name")).append(" ×").append(it.optInt("qty"));
            }
            String note = o.optString("note", "");
            if (!note.isEmpty() && !"null".equals(note)) sb.append("\n요청: ").append(note);
            alert("🍜 " + o.optString("seat_name") + " 주문", sb.toString());
        }

        JSONArray msgs = Api.getArray(base + "messages?select=id,seat_id,kind,text&sender=eq.guest&order=id.asc&id=gt." + lastMsg, key, tok);
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            lastMsg = Math.max(lastMsg, m.getLong("id"));
            String seat = seatNames.containsKey(m.optString("seat_id")) ? seatNames.get(m.optString("seat_id")) : "PC";
            if ("call".equals(m.optString("kind"))) alert("🔔 " + seat + " 호출", seat + "에서 카운터를 호출했어요.");
            else alert("💬 " + seat, m.optString("text"));
        }
    }

    private long maxId(String url, String key, String tok) throws Exception {
        JSONArray a = Api.getArray(url, key, tok);
        return a.length() > 0 ? a.getJSONObject(0).getLong("id") : 0;
    }
}
