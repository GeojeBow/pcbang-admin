package local.pcbang.admin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Supabase REST/Auth 호출 */
class Api {
    static class HttpError extends Exception {
        final int code;
        HttpError(int code, String msg) { super(msg); this.code = code; }
    }

    static String request(String method, String url, String apikey, String token, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        if (apikey != null) c.setRequestProperty("apikey", apikey);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/json");
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        if (in != null) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            in.close();
        }
        String text = buf.toString("UTF-8");
        c.disconnect();
        if (code >= 400) throw new HttpError(code, text.length() > 200 ? text.substring(0, 200) : text);
        return text;
    }

    static JSONObject post(String url, String apikey, String token, JSONObject body) throws Exception {
        return new JSONObject(request("POST", url, apikey, token, body.toString()));
    }

    static JSONArray getArray(String url, String apikey, String token) throws Exception {
        return new JSONArray(request("GET", url, apikey, token, null));
    }
}
