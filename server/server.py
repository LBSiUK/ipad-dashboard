#!/usr/bin/env python3
"""iPad dashboard backend.

Serves the static page in ../web and one JSON endpoint, /api/state, that
joins weather (Open-Meteo), Google Calendar (secret iCal URL) and the status
reported by the per-machine agents. Plain HTTP on the LAN on purpose: iOS 9
Safari does not trust current public TLS roots.
"""
import argparse
import json
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")

OFFLINE_AFTER = 45          # seconds without a report before a machine is offline
WEATHER_EVERY = 600
CALENDAR_EVERY = 300
POLL_EVERY = 15
EVENT_WINDOW_H = 60         # hours of events sent to the page

lock = threading.Lock()
cfg = {}
runtime = {"location": None}          # persisted in state.json
cache = {"weather": None, "events": None, "events_error": None,
         "weather_error": None}
reports = {}                          # id -> {"data": {...}, "received": ts}
MOCK = False


# ---------------------------------------------------------------- config ---
def load_config(path):
    with open(path) as f:
        c = json.load(f)
    c.setdefault("port", 8090)
    c.setdefault("timezone", "Europe/London")
    c.setdefault("ics_url", "")
    c.setdefault("location", {"name": "Moulescoomb, Brighton",
                              "lat": 50.8625, "lon": -0.1170})
    return c


def state_path():
    return os.path.join(cfg["_dir"], "state.json")


def load_runtime():
    try:
        with open(state_path()) as f:
            runtime.update(json.load(f))
    except (OSError, ValueError):
        pass


def save_runtime():
    tmp = state_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(runtime, f)
    os.replace(tmp, state_path())


def location():
    return runtime.get("location") or cfg["location"]


def http_json(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# --------------------------------------------------------------- weather ---
def fetch_weather():
    loc = location()
    q = urllib.parse.urlencode({
        "latitude": loc["lat"], "longitude": loc["lon"],
        "current": "temperature_2m,apparent_temperature,weather_code,"
                   "wind_speed_10m,is_day,precipitation",
        "hourly": "temperature_2m,precipitation_probability,precipitation,"
                  "weather_code,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                 "sunrise,sunset",
        "timezone": cfg["timezone"], "forecast_days": 3,
        "timeformat": "unixtime", "wind_speed_unit": "mph",
    })
    d = http_json("https://api.open-meteo.com/v1/forecast?" + q)
    cur, hr, dy = d["current"], d["hourly"], d["daily"]
    hourly = [{
        "t": hr["time"][i],
        "temp": round(hr["temperature_2m"][i], 1),
        "pop": hr["precipitation_probability"][i] or 0,
        "mm": hr["precipitation"][i] or 0,
        "code": hr["weather_code"][i],
        "day": hr["is_day"][i],
    } for i in range(len(hr["time"]))]
    daily = [{
        "t": dy["time"][i], "code": dy["weather_code"][i],
        "max": round(dy["temperature_2m_max"][i]),
        "min": round(dy["temperature_2m_min"][i]),
        "sunrise": dy["sunrise"][i], "sunset": dy["sunset"][i],
    } for i in range(len(dy["time"]))]
    return {
        "place": loc["name"], "lat": loc["lat"], "lon": loc["lon"],
        "updated": int(time.time()),
        "current": {
            "temp": round(cur["temperature_2m"]),
            "feels": round(cur["apparent_temperature"]),
            "code": cur["weather_code"], "wind": round(cur["wind_speed_10m"]),
            "day": cur["is_day"], "mm": cur["precipitation"],
        },
        "hourly": hourly, "daily": daily,
    }


# -------------------------------------------------------------- calendar ---
def fetch_events():
    import icalendar
    import recurring_ical_events
    tz = ZoneInfo(cfg["timezone"])
    req = urllib.request.Request(cfg["ics_url"],
                                 headers={"User-Agent": "ipad-dashboard"})
    with urllib.request.urlopen(req, timeout=30) as r:
        cal = icalendar.Calendar.from_ical(r.read())
    now = datetime.now(tz)
    start = now - timedelta(hours=3)
    end = now + timedelta(hours=EVENT_WINDOW_H)
    out = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        s, e = ev.get("DTSTART").dt, ev.get("DTEND")
        e = e.dt if e is not None else None
        all_day = not isinstance(s, datetime)
        if all_day:
            s = datetime.combine(s, datetime.min.time(), tz)
            e = datetime.combine(e, datetime.min.time(), tz) if e \
                else s + timedelta(days=1)
        else:
            if s.tzinfo is None:
                s = s.replace(tzinfo=tz)
            e = (e.replace(tzinfo=tz) if e is not None and e.tzinfo is None
                 else e) or s
        status = str(ev.get("STATUS", "")).upper()
        if status == "CANCELLED":
            continue
        out.append({
            "title": str(ev.get("SUMMARY", "(no title)")),
            "start": int(s.timestamp()), "end": int(e.timestamp()),
            "allDay": all_day, "where": str(ev.get("LOCATION", "") or ""),
        })
    out.sort(key=lambda x: (not x["allDay"], x["start"]))
    return out


# --------------------------------------------------------------- servers ---
def poll_sources():
    for s in cfg.get("servers", []):
        p = s.get("poll")
        if not p:
            continue
        try:
            data = http_json(p["url"], {"Authorization": "Bearer " + p["token"],
                                        "User-Agent": "ipad-dashboard"}, 10)
            with lock:
                reports[s["id"]] = {"data": data, "received": time.time()}
        except Exception:
            pass


def servers_state():
    now = time.time()
    out = []
    with lock:
        for s in cfg.get("servers", []):
            r = reports.get(s["id"])
            item = {"id": s["id"], "name": s["name"], "site": s.get("site", "")}
            if r and now - r["received"] <= OFFLINE_AFTER:
                item["online"] = True
                item.update(r["data"])
            else:
                item["online"] = False
                item["lastSeen"] = int(r["received"]) if r else None
            out.append(item)
    return out


# ------------------------------------------------------------------ mock ---
def mock_state():
    now = int(time.time())
    tz = ZoneInfo(cfg["timezone"])
    mid = int(datetime.now(tz).replace(hour=0, minute=0, second=0,
                                       microsecond=0).timestamp())
    hourly = []
    for i in range(72):
        t = mid + i * 3600
        h = (t - mid) / 3600 % 24
        pop = 0
        k = (t - now) / 3600
        if 2 <= k < 9:
            pop = [15, 40, 70, 90, 65, 35, 12][int(k) - 2]
        code = 61 if pop >= 60 else 3 if pop else 2 if 8 < h < 20 else 1
        hourly.append({"t": t, "temp": round(9 + 5 * math.sin((h - 9) / 24 * 2 * math.pi), 1),
                       "pop": pop, "mm": round(pop / 60, 1) if pop > 40 else 0,
                       "code": code, "day": 1 if 7 <= h < 18 else 0})
    daily = [{"t": mid + d * 86400, "code": [61, 3, 2][d], "max": [14, 13, 15][d],
              "min": [8, 7, 6][d], "sunrise": mid + d * 86400 + 7 * 3600 + 20 * 60,
              "sunset": mid + d * 86400 + 18 * 3600 + 15 * 60} for d in range(3)]
    base = now - now % 900
    ev = lambda title, off_m, dur_m, where="": {
        "title": title, "start": base + off_m * 60, "end": base + (off_m + dur_m) * 60,
        "allDay": False, "where": where}
    events = [
        {"title": "Nan's birthday", "start": mid, "end": mid + 86400, "allDay": True, "where": ""},
        ev("Stand-up", -20, 30), ev("Lecture: Compilers", 60, 120, "Chichester 1"),
        ev("Lunch with Sam", 150, 60), ev("Render farm check", 190, 30),
        ev("Dentist", 330, 45, "Preston Park"), ev("Gym", 560, 75),
        ev("Call with Jon", 1500, 30),
    ]
    def srv(id_, name, site, temp, up, load, mem, disk, cores, cpu):
        return {"id": id_, "name": name, "site": site, "online": True, "cpuTemp": temp,
                "uptime": up, "load1": load, "cpu": cpu, "mem": mem, "disk": disk,
                "cores": cores, "kernel": "7.2.5"}
    servers = [
        srv("provenance-1", "Provenance-1", "Brighton", 54, 18 * 86400 + 5 * 3600, 0.42, 38, 61, 4, 11),
        srv("hpdesk2", "hpdesk2", "Brighton", 71, 19 * 86400 + 3600, 3.9, 74, 58, 4, 96),
        srv("asuslap", "AsusLap", "Brighton", 63, 2 * 86400 + 7200, 1.1, 52, 83, 8, 23),
        {"id": "hpdesk", "name": "hpdesk", "site": "Finchley", "online": False,
         "lastSeen": now - 540},
    ]
    return {
        "now": now, "tz": cfg["timezone"], "mock": True,
        "weather": {"place": location()["name"], "lat": 50.8625, "lon": -0.117,
                    "updated": now,
                    "current": {"temp": 11, "feels": 9, "code": 3, "wind": 12, "day": 1, "mm": 0},
                    "hourly": hourly, "daily": daily},
        "events": events, "calendar": {"ok": True, "error": None},
        "servers": servers,
    }


# ---------------------------------------------------------------- state ----
def build_state():
    if MOCK:
        return mock_state()
    with lock:
        w, ev = cache["weather"], cache["events"]
        werr, eerr = cache["weather_error"], cache["events_error"]
    return {
        "now": int(time.time()), "tz": cfg["timezone"], "mock": False,
        "weather": w, "weatherError": werr,
        "events": ev if ev is not None else [],
        "calendar": {"ok": ev is not None and not eerr,
                     "configured": bool(cfg["ics_url"]), "error": eerr},
        "servers": servers_state(),
    }


def refresher(name, fn, every, enabled=lambda: True):
    def loop():
        while True:
            if enabled():
                try:
                    val = fn()
                    with lock:
                        cache[name] = val
                        cache[name + "_error"] = None
                except Exception as e:  # keep serving the last good value
                    with lock:
                        cache[name + "_error"] = "%s: %s" % (type(e).__name__, e)
            time.sleep(every)
    threading.Thread(target=loop, daemon=True).start()


def kick_weather():
    def go():
        try:
            val = fetch_weather()
            with lock:
                cache["weather"], cache["weather_error"] = val, None
        except Exception as e:
            with lock:
                cache["weather_error"] = "%s: %s" % (type(e).__name__, e)
    threading.Thread(target=go, daemon=True).start()


# ------------------------------------------------------------------ http ---
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".woff": "font/woff",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".json": "application/json"}


def render_index():
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        html = f.read()
    with open(os.path.join(WEB, "icons.svg.html"), encoding="utf-8") as f:
        return html.replace("<!--ICONS-->", f.read()).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "ipad-dashboard"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", cache_ctl="no-store"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_ctl)
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(min(n, 65536)) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            return self.send(200, build_state())
        if u.path == "/favicon.ico":
            return self.send(204, b"", "image/x-icon")
        if u.path == "/healthz":
            return self.send(200, {"ok": True})
        if u.path == "/api/geocode":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0].strip()
            if len(q) < 2:
                return self.send(200, {"results": []})
            try:
                d = http_json("https://geocoding-api.open-meteo.com/v1/search?" +
                              urllib.parse.urlencode({"name": q, "count": 6,
                                                      "language": "en", "format": "json"}))
                res = [{"name": ", ".join(x for x in (r["name"], r.get("admin1"), r.get("country")) if x),
                        "lat": r["latitude"], "lon": r["longitude"]}
                       for r in d.get("results", [])]
                return self.send(200, {"results": res})
            except Exception as e:
                return self.send(502, {"error": str(e)})
        return self.static(u.path)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            data = self.body_json()
        except ValueError:
            return self.send(400, {"error": "bad json"})
        if u.path == "/api/report":
            if self.headers.get("X-Token") != cfg.get("token"):
                return self.send(403, {"error": "bad token"})
            sid = data.get("id")
            if not any(s["id"] == sid for s in cfg.get("servers", [])):
                return self.send(404, {"error": "unknown server id"})
            data.pop("id", None)
            with lock:
                reports[sid] = {"data": data, "received": time.time()}
            return self.send(200, {"ok": True})
        if u.path == "/api/clientlog":
            print("client[%s] %s | %s" % (data.get("v"), data.get("msg"), str(data.get("ua"))[:90]), flush=True)
            return self.send(200, {"ok": True})
        if u.path == "/api/location":
            try:
                loc = {"name": str(data["name"])[:80],
                       "lat": float(data["lat"]), "lon": float(data["lon"])}
                assert -90 <= loc["lat"] <= 90 and -180 <= loc["lon"] <= 180
            except Exception:
                return self.send(400, {"error": "need name, lat, lon"})
            runtime["location"] = loc
            save_runtime()
            kick_weather()
            return self.send(200, {"ok": True})
        return self.send(404, {"error": "not found"})

    def static(self, path):
        if path in ("/", "/index.html"):
            return self.send(200, render_index(), MIME[".html"])
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.join(WEB, rel)
        if rel.startswith("..") or not os.path.isfile(full):
            return self.send(404, b"not found", "text/plain")
        ext = os.path.splitext(full)[1]
        with open(full, "rb") as f:
            body = f.read()
        ctl = "public, max-age=2592000" if ext == ".woff" else "no-cache"
        return self.send(200, body, MIME.get(ext, "application/octet-stream"), ctl)


def main():
    global cfg, MOCK
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()
    cfg = load_config(args.config)
    cfg["_dir"] = os.path.dirname(os.path.abspath(args.config))
    MOCK = args.mock
    load_runtime()
    if not MOCK:
        refresher("weather", fetch_weather, WEATHER_EVERY)
        refresher("events", fetch_events, CALENDAR_EVERY,
                  enabled=lambda: bool(cfg["ics_url"]))
        refresher("poll", lambda: poll_sources(), POLL_EVERY)
    port = args.port or cfg["port"]
    print("ipad-dashboard on :%d%s" % (port, " (mock)" if MOCK else ""), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
