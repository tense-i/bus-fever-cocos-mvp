#!/usr/bin/env bash
# Replay the Level 1 acceptance route on the 1080x2400 Android profile.
# Usage: bash tools/replay_level_one.sh <tested-apk> <evidence-directory> [adb-serial]
set -eu
apk=${1:?Provide the tested APK}
proof=${2:?Provide an evidence directory}
serial=${3:-emulator-5586}
mkdir -p "$proof"
pkg=local.cocos.busfeverplay
adb -s "$serial" shell am force-stop "$pkg"
device_apk=$(adb -s "$serial" shell pm path "$pkg" | sed -n 's/^package://p' | tr -d '\r')
adb -s "$serial" shell sha256sum "$device_apk" | tr -d '\r' > "$proof/installed.sha256"
shasum -a 256 "$apk" > "$proof/candidate.sha256"
test "$(cut -d ' ' -f1 "$proof/installed.sha256")" = "$(cut -d ' ' -f1 "$proof/candidate.sha256")"
record="/sdcard/level-one-individual-$(date +%s).mp4"
adb -s "$serial" shell "echo \$\$; exec screenrecord --time-limit 150 --size 540x1200 --bit-rate 4200000 '$record'" > "$proof/screenrecord.log" 2>&1 &
record_pid=$!
save_recording() {
  echo "Recorded outcome=$1"
  if [ -n "${pid:-}" ]; then adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/e2e-runtime.log"; fi
  recorder=$(head -1 "$proof/screenrecord.log" | tr -d '\r')
  if [[ "$recorder" =~ ^[0-9]+$ ]] && kill -0 "$record_pid" 2>/dev/null; then
    if adb -s "$serial" shell cat "/proc/$recorder/cmdline" | tr '\0' '\n' | rg -Fxq "$record"; then
      adb -s "$serial" shell kill -2 "$recorder" || true
    fi
  fi
  wait "$record_pid" || true
  adb -s "$serial" pull "$record" "$proof/e2e.mp4" || true
}
trap 'save_recording "$?"' EXIT
sleep 0.6
adb -s "$serial" shell am start -W -n "$pkg/com.cocos.game.AppActivity"
pid=$(adb -s "$serial" shell pidof "$pkg" | tr -d '\r')
wait_log() {
  needle="$1"
  target="$2"
  for attempt in $(seq 1 100); do
    if ! adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/runtime-snapshot.log"; then
      sleep 0.18
      continue
    fi
    mv "$proof/runtime-snapshot.log" "$proof/runtime-current.log"
    count=$(rg -cF "$needle" "$proof/runtime-current.log" || true)
    if [ "${count:-0}" -ge "$target" ]; then return; fi
    sleep 0.18
  done
  echo "Missing event: $needle ($target)"
  return 1
}
capture() {
  destination="$proof/$1.png"
  for attempt in $(seq 1 6); do
    if adb -s "$serial" exec-out screencap -p > "$destination.part" &&
      test "$(tail -c 12 "$destination.part" | xxd -p)" = '0000000049454e44ae426082'; then
      mv "$destination.part" "$destination"
      return
    fi
    sleep 0.25
  done
  return 1
}
wait_log '[OwnedGameplay] tap-centers' 1
sed -n 's/^.*\[OwnedGameplay\] tap-centers //p' "$proof/runtime-current.log" | tail -1 > "$proof/tap-centers.json"
tap_car() {
  local coords x y
  coords=$(jq -er --arg id "$1" '.values[] | select(.id==$id) | [.x,.y] | @tsv' "$proof/tap-centers.json")
  read -r x y <<< "$coords"
  adb -s "$serial" shell input tap "$x" "$y"
}
capture opening
sleep 0.92
capture moving
wait_log '[OwnedGameplay] passengers-in-ring 240 avatars=240' 1
rg -F 'vat idle=1+60 move=61+19 board=80+19' "$proof/runtime-current.log"
capture ready
tap_car Y1
tap_car Y2
tap_car R1
tap_car R2
wait_log '"event":"lost"' 1
capture lost
adb -s "$serial" shell input tap 539 1414
wait_log '[OwnedGameplay] passengers-in-ring 240 avatars=240' 2
tap_car B1
sleep 0.26
capture enter-motion
wait_log 'boarded B1 count=2 remaining=38' 1
tap_car Y1
wait_log '"event":"parked","vehicle":"Y1"' 2
sleep 0.20
capture concurrent-parking
wait_log '"event":"departed","vehicle":"B1"' 1
capture after-blue-wave
sleep 1
capture after-blue-wave-plus-one
wait_log '[OwnedGameplay] belt-refill ' 1
sleep 0.54
capture exit-motion
wait_log '"event":"departed","vehicle":"B1"' 1
tap_car Y2
sleep 0.55
tap_car B2
wait_log '"event":"parked","vehicle":"B2"' 1
tap_car R1
wait_log '"event":"departed","vehicle":"Y1"' 1
tap_car R2
wait_log '"event":"won"' 1
wait_log '[OwnedGameplay] victory-spine idle' 1
capture won
adb -s "$serial" shell 'input tap 543 1691; input tap 543 1691'
wait_log '[OwnedGameplay] victory-reward {"amount":20,"balance":120}' 1
capture reward
adb -s "$serial" shell input tap 543 1691
wait_log '[OwnedGameplay] passengers-in-ring 240 avatars=240' 3
tap_car B1
sleep 0.14
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 1
sleep 0.24
capture driving-paused-a
sleep 0.8
capture driving-paused-b
cmp "$proof/driving-paused-a.png" "$proof/driving-paused-b.png"
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] animate-board B1' 41
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 2
paused_count=$(rg -cF '[OwnedGameplay] boarded ' "$proof/runtime-current.log")
sleep 1
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/paused-runtime.log"
test "$paused_count" = "$(rg -cF '[OwnedGameplay] boarded ' "$proof/paused-runtime.log")"
printf 'board-animation-completions-frozen-at=%s\n' "$paused_count" > "$proof/pause-assertion.txt"
adb -s "$serial" shell input tap 67 80
wait_log '[OwnedGameplay] passengers-in-ring 240 avatars=240' 4
capture reset
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/e2e-runtime.log"
sed -nE 's/^.*\[OwnedGameplay\] (\{.*\})$/\1/p' "$proof/e2e-runtime.log" > "$proof/e2e.ndjson"
jq -se '
  (map(select(.event=="lost")|[.boarded,.outcome,(.bays|map(.seatsLeft))]) == [[0,"lost",[40,40,40,40]]]) and
  (any(.[]; .event=="parked" and .vehicle=="Y1" and .boarded>0 and .boarded<40 and
             any(.bays[]; .id=="B1" and .stage=="parked" and .seatsLeft>0))) and
  (map(select(.event=="departed")|.vehicle)|sort == ["B1","B2","R1","R2","Y1","Y2"]) and
  (map(select(.event=="won")|[.boarded,.outcome,.bays]) == [[240,"won",[]]]) and
  ((map(select(.event=="enter" or .event=="restart")|del(.event))|unique|length)==1) and
  (map(select(.event=="restart"))|length==3)
' "$proof/e2e.ndjson" > "$proof/assertion.txt"
test "$(rg -cF '[OwnedGameplay] victory-reward' "$proof/e2e-runtime.log")" = 1
test "$(rg -c 'vehicle-motion [BRY][12] exit smoke=[1-9][0-9]*' "$proof/e2e-runtime.log")" = 6
test "$(rg -c 'vehicle-motion [BRY][12] enter smoke=[1-9][0-9]*' "$proof/e2e-runtime.log")" = 11
rg -F '[OwnedGameplay] vehicle-motion' "$proof/e2e-runtime.log" > "$proof/drive-events.txt"
python3 - "$proof/e2e-runtime.log" "$proof/individual-boarding.json" <<'PY'
import json,re,sys
from pathlib import Path
counts={}
starts=0
in_flight=0
peak=0
refilled=[]
for line in Path(sys.argv[1]).read_text().splitlines():
    if '"event":"won"' in line: break
    refill=re.search(r'belt-refill rider=(\d+) cell=(\d+)',line)
    if refill: refilled.append(int(refill[1]))
    if '[OwnedGameplay] animate-board ' in line:
        starts+=1
        in_flight+=1
        peak=max(peak,in_flight)
    match=re.search(r'\[OwnedGameplay\] boarded (\w+) count=(\d+) remaining=(\d+)',line)
    if match:
        bus,total,left=match.groups()
        in_flight-=1
        counts.setdefault(bus,[]).append(int(left))
        assert int(total)==sum(map(len,counts.values()))
assert set(counts)==set("B1 B2 Y1 Y2 R1 R2".split())
assert all(seq==list(range(39,-1,-1)) for seq in counts.values())
assert starts==240 and in_flight==0 and peak>1
assert refilled==list(range(195,240))
Path(sys.argv[2]).write_text(json.dumps({"boardings":starts,"peakInTransit":peak,"countsByVehicle":{bus:len(seq) for bus,seq in counts.items()}},indent=2)+"\n")
PY
cat "$proof/assertion.txt" "$proof/individual-boarding.json" "$proof/pause-assertion.txt"
jq -c 'select(.event=="lost" or .event=="won" or .event=="departed")' "$proof/e2e.ndjson"
