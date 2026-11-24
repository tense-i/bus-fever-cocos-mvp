"""Replay the six Level 1 tutorial taps and check the last red bus against the walkthrough."""
import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path

PACKAGE = "local.cocos.busfeverplay"
MARKER = "[OwnedGameplay] "
# Host send times account for the measured adb input delay on the Android 15 emulator.
TAPS = (("B1", 5.12), ("Y1", 7.04), ("Y2", 9.29), ("B2", 11.52), ("R1", 15.30), ("R2", 18.39))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adb")
    parser.add_argument("serial")
    parser.add_argument("apk", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    out = args.evidence
    out.mkdir(parents=True, exist_ok=True)
    device = [args.adb, "-s", args.serial]

    def adb(*command):
        return subprocess.check_output([*device, *map(str, command)], text=True).strip()

    adb("install", "-r", args.apk)
    package_path = adb("shell", "pm", "path", PACKAGE).splitlines()[0].removeprefix("package:")
    installed_hash = adb("shell", "sha256sum", package_path).split()[0]
    if installed_hash != hashlib.sha256(args.apk.read_bytes()).hexdigest():
        raise RuntimeError("Installed APK differs from the candidate")
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/com.cocos.game.AppActivity")
    pid = adb("shell", "pidof", PACKAGE)

    def logs():
        return adb("logcat", "-d", "--pid=" + pid, "-v", "epoch")

    def until(marker, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                lines = logs()
            except subprocess.CalledProcessError:
                time.sleep(0.2)
                continue
            if marker in lines:
                return lines
            time.sleep(0.13)
        raise RuntimeError("Missing Android event: " + marker)

    initial = until(MARKER + "tap-centers ", 25).splitlines()
    enter = next(line for line in initial if MARKER + '{"event":"enter"' in line)
    zero = float(enter.split()[0])
    tap_line = next(line for line in initial if MARKER + "tap-centers " in line)
    centers = {v["id"]: (v["x"], v["y"]) for v in json.loads(tap_line.split("tap-centers ", 1)[1])["values"]}
    remote = "/sdcard/bus-fever-reference-" + str(time.time_ns()) + ".mp4"
    record_log = out / "screenrecord.log"
    with record_log.open("w") as stream:
        recorder = subprocess.Popen([*device, "shell", "echo $$; date +%s.%N; exec screenrecord "
                                     "--time-limit 65 --size 540x1200 --bit-rate 4500000 " + remote],
                                    stdout=stream, stderr=subprocess.STDOUT)
    try:
        device_now = float(adb("shell", "date", "+%s.%N"))
        host_zero = time.monotonic() - (device_now - zero)
        for vehicle, offset in TAPS:
            time.sleep(max(0, host_zero + offset - time.monotonic()))
            adb("shell", "input", "tap", *centers[vehicle])
        until(MARKER + '{"event":"won"', 40)
        time.sleep(1.5)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        (out / "reference-result.json").write_text(json.dumps({
            "passed": False, "serial": args.serial, "apkSHA256": installed_hash,
            "tapSchedule": TAPS, "error": str(error),
        }, indent=2) + "\n")
        raise
    finally:
        text = logs()
        (out / "runtime.log").write_text(text)
        info = record_log.read_text().splitlines()
        if info and info[0].isdigit() and recorder.poll() is None:
            adb("shell", "kill", "-2", info[0])
        recorder.wait(timeout=10)
        adb("pull", remote, out / "gameplay.mp4")
        if len(info) > 1:
            (out / "record-start-offset.txt").write_text(str(float(info[1]) - zero))

    dispatch = []
    red_seats = 40
    won_at = None
    total_boarded = None
    for line in text.splitlines():
        if MARKER not in line:
            continue
        stamp = float(line.split()[0]) - zero
        message = line.split(MARKER, 1)[1]
        if message.startswith("{"):
            event = json.loads(message)
            if event.get("event") == "dispatch":
                vehicle = event["vehicle"]
                bay = next(b["slot"] for b in event["bays"] if b["id"] == vehicle)
                dispatch.append({"vehicle": vehicle, "seconds": round(stamp, 3), "bay": bay})
            if event.get("event") == "won":
                won_at = round(stamp, 3)
                total_boarded = event["boarded"]
        elif stamp <= 20.8:
            match = re.match(r"boarded R2 count=\d+ remaining=(\d+)", message)
            if match:
                red_seats = int(match[1])

    # 20.8 s is inside the visible 8-seat plateau on the supplied walkthrough.
    expected = {"vehicles": [v for v, _ in TAPS], "bays": [0, 1, 0, 2, 0, 0],
                "redSeatsAt20.8s": 8, "boarded": 240}
    actual = {"vehicles": [d["vehicle"] for d in dispatch], "bays": [d["bay"] for d in dispatch],
              "redSeatsAt20.8s": red_seats, "boarded": total_boarded}
    report = {"reference": "BV1pNHs6aEUC", "serial": args.serial, "apkSHA256": installed_hash,
              "tapSchedule": TAPS, "dispatch": dispatch, "winEventSeconds": won_at,
              "expected": expected, "actual": actual, "passed": actual == expected}
    (out / "reference-result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(actual))
    if actual != expected:
        raise SystemExit("Walkthrough mismatch; inspect reference-result.json and gameplay.mp4")


if __name__ == "__main__":
    main()
