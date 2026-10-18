#!/usr/bin/env python3
"""Per-machine stats agent for the iPad dashboard. Standard library only, Linux only.

  agent.py --id hpdesk2 --push http://DASHBOARD-HOST:8090 --token SECRET
      posts a report every 15 s (machines on the same LAN as the dashboard server)

  agent.py --serve 9101 --token SECRET
      answers GET /stats with the same JSON, for the server to poll
      (hpdesk, which sits behind a Cloudflare Tunnel)
"""
import argparse
import glob
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TEMP_CHIPS = ("coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "acpitz")


def read(path):
    with open(path) as f:
        return f.read().strip()


def cpu_temp():
    """Package temperature in C from the first sensible hwmon chip, else a thermal zone."""
    by_name = {}
    for d in glob.glob("/sys/class/hwmon/hwmon*"):
        try:
            by_name.setdefault(read(d + "/name"), d)
        except OSError:
            pass
    for chip in TEMP_CHIPS:
        d = by_name.get(chip)
        if not d:
            continue
        vals = []
        for f in sorted(glob.glob(d + "/temp*_input")):
            label = ""
            try:
                label = read(f.replace("_input", "_label"))
            except OSError:
                pass
            try:
                v = int(read(f)) / 1000.0
            except (OSError, ValueError):
                continue
            if label.startswith(("Package", "Tctl", "Tdie")):
                return round(v, 1)
            vals.append(v)
        if vals:
            return round(max(vals), 1)
    for z in glob.glob("/sys/class/thermal/thermal_zone*/temp"):
        try:
            return round(int(read(z)) / 1000.0, 1)
        except (OSError, ValueError):
            pass
    return None


_prev = {"idle": None, "total": None}


def cpu_percent():
    f = read("/proc/stat").splitlines()[0].split()[1:]
    vals = [int(x) for x in f]
    idle, total = vals[3] + vals[4], sum(vals)
    p_idle, p_total = _prev["idle"], _prev["total"]
    _prev["idle"], _prev["total"] = idle, total
    if p_total is None or total == p_total:
        return None
    return round(100.0 * (1 - (idle - p_idle) / (total - p_total)), 1)


def mem_percent():
    m = {}
    for line in read("/proc/meminfo").splitlines():
        k, v = line.split(":")
        m[k] = int(v.split()[0])
    return round(100.0 * (1 - m["MemAvailable"] / m["MemTotal"]), 1)


def disk_percent(path="/"):
    s = os.statvfs(path)
    used = (s.f_blocks - s.f_bfree) * s.f_frsize
    avail = s.f_bavail * s.f_frsize
    return round(100.0 * used / (used + avail), 1)


def collect():
    return {
        "uptime": int(float(read("/proc/uptime").split()[0])),
        "cpuTemp": cpu_temp(),
        "load1": float(read("/proc/loadavg").split()[0]),
        "cpu": cpu_percent(),
        "mem": mem_percent(),
        "disk": disk_percent(),
        "cores": os.cpu_count(),
        "kernel": os.uname().release,
    }


def push(args):
    url = args.push.rstrip("/") + "/api/report"
    cpu_percent()                                    # prime the delta
    while True:
        time.sleep(args.interval)
        try:
            body = dict(collect(), id=args.id)
            req = urllib.request.Request(
                url, json.dumps(body).encode(), {"Content-Type": "application/json",
                                                 "X-Token": args.token})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            print("report failed:", e, flush=True)


def serve(args):
    cache = {"data": None}

    def sampler():
        cpu_percent()
        while True:
            time.sleep(args.interval)
            try:
                cache["data"] = collect()
            except Exception as e:
                print("collect failed:", e, flush=True)
    threading.Thread(target=sampler, daemon=True).start()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            ok = self.headers.get("Authorization") == "Bearer " + args.token
            if self.path != "/stats" or not ok or cache["data"] is None:
                self.send_response(403 if not ok else 503)
                self.end_headers()
                return
            body = json.dumps(cache["data"]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer((args.bind, args.serve), H).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--interval", type=int, default=15)
    ap.add_argument("--id")
    ap.add_argument("--push")
    ap.add_argument("--serve", type=int)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--print", action="store_true", help="print one sample and exit")
    args = ap.parse_args()
    if args.print:
        cpu_percent()
        time.sleep(1)
        print(json.dumps(collect(), indent=1))
    elif args.push and args.id:
        push(args)
    elif args.serve:
        serve(args)
    else:
        ap.error("use --push URL with --id, or --serve PORT")


if __name__ == "__main__":
    main()
