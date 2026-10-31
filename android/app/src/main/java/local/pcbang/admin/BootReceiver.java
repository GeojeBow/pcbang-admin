package local.pcbang.admin;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 핸드폰을 켜거나 앱이 업데이트되면 알림 서비스를 다시 시작한다 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AlertService.startIfReady(context);
    }
}
