# Sourced by replay_level_one.sh after collecting the first reward.
wait_log '[OwnedGameplay] sky-transition 1->2' 1
capture transition
wait_log '[OwnedGameplay] level-playable 2' 1
sed -n 's/^.*\[OwnedGameplay\] tap-centers //p' "$proof/runtime-current.log" | tail -1 > "$proof/tap-centers.json"
cp "$proof/tap-centers.json" "$proof/second-centers.json"
capture second-grid
if [[ "$scenario" = second-failure-fixture ]]; then
  wait_log '[OwnedGameplay] passengers-in-ring 480 avatars=480' 1
  for car in V2 V1 O1 O2; do
    tap_car "$car"
    wait_log '"event":"parked","vehicle":"'"$car"'"' 1
  done
  wait_log '"event":"lost","level":2' 1
  capture second-lost
  adb -s "$serial" shell input tap 539 1414
  wait_log '"event":"restart","level":2' 1
  capture second-reset
  sed -nE 's/^.*\[OwnedGameplay\] (\{.*\})$/\1/p' "$proof/runtime-current.log" > "$proof/e2e.ndjson"
  jq -se '([.[] | select(.event=="lost") | [.level,.boarded,[.bays[].seatsLeft]]] == [[2,0,[40,40,40,40]]])
          and ([.[] | select(.event=="restart") | [.level,.boarded,.bays,(.ready|length)]] == [[2,0,[],12]])' "$proof/e2e.ndjson" > "$proof/assertion.txt"
  exit 0
fi
# Frame measurements from BV1pNHs6aEUC; the Level 2 board takes over at ~30.65 s.
python3 - "$serial" "$pid" "$proof" <<'PY'
import json,subprocess,sys,time
from pathlib import Path
serial,pid,out=sys.argv[1:];out=Path(out)
def adb(*args):
    return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
log=adb('logcat','-d','--pid='+pid,'-v','epoch')
zero=float(next(l.split()[0] for l in reversed(log.splitlines()) if "level-playable 2" in l))
coords={v['id']:(v['x'],v['y']) for v in json.loads((out/'second-centers.json').read_text())['values']}
events=[('V2',34.26),('V1',36.10),('O1',39.51),('O2',42.83),('P1',45.04),('V3',47.68),
        ('G1',50.05),('G2',51.75),('O3',54.64),('P2',58.47),('O4',60.18),('G3',62.82)]
origin=time.monotonic()-(float(adb('shell','date','+%s.%N'))-zero)
for car,stamp in events:
    time.sleep(max(0,origin+stamp-30.65-0.05-time.monotonic()))
    adb('shell','input','tap',*map(str,coords[car]))
(out/'second-inputs.json').write_text(json.dumps(events,indent=2)+'\n')
PY
wait_log '"event":"won","level":2' 1
wait_log '[OwnedGameplay] victory-spine idle' 2
capture second-won
adb -s "$serial" shell 'input tap 543 1691; input tap 543 1691'
wait_log '[OwnedGameplay] victory-reward {"amount":20,"balance":140}' 1
capture second-reward
adb -s "$serial" shell input tap 543 1691
wait_log '"event":"restart","level":2' 1
wait_log '[OwnedGameplay] passengers-in-ring 480 avatars=480' 2
capture second-replay-grid

for pair in 'V1 V2' 'O1 V1' 'V3 V1' 'G2 G1'; do
  read -r car blocker <<< "$pair"
  tap_car "$car"
  wait_log "[OwnedGameplay] contact $car $blocker" 1
  wait_log "[OwnedGameplay] returned $car" 1
done
capture second-obstructions
tap_car V2
sleep 0.12
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 1
sleep 0.25
capture second-drive-paused-a
sleep 0.6
capture second-drive-paused-b
cmp "$proof/second-drive-paused-a.png" "$proof/second-drive-paused-b.png"
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] animate-board V2' 41
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 2
paused=$(rg -cF '[OwnedGameplay] boarded ' "$proof/runtime-current.log")
sleep 0.65
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/paused-runtime.log"
test "$paused" = "$(rg -cF '[OwnedGameplay] boarded ' "$proof/paused-runtime.log")"
adb -s "$serial" shell input tap 67 80
wait_log '"event":"restart","level":2' 2

capture second-reset
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/e2e-runtime.log"
sed -nE 's/^.*\[OwnedGameplay\] (\{.*\})$/\1/p' "$proof/e2e-runtime.log" > "$proof/e2e.ndjson"
python3 - "$proof" <<'PY'
from pathlib import Path
import json,re,sys,collections
p=Path(sys.argv[1]);events=[json.loads(l) for l in (p/'e2e.ndjson').read_text().splitlines()]
wins=[(e['level'],e['boarded'],e['bays']) for e in events if e['event']=='won']
assert wins==[(1,240,[]),(2,480,[])],wins
assert [e['vehicle'] for e in events if e['event']=='contact-return']==['V1','O1','V3','G2']
for e in events:
    if e['event'] in ('restart','next-level','contact-return'):
        assert e['level']==2 and e['bays']==[] and len(e['ready'])==12 and e['boarded']==0
assert not any(e['event']=='lost' for e in events)
assert any(e['event']=='parked' and e.get('vehicle')=='Y1' and 0<e['boarded']<40
           and any(b['id']=='B1' and b['stage']=='parked' and b['seatsLeft']>0 for b in e['bays']) for e in events)
expected=[row[0] for row in json.loads((p/'second-inputs.json').read_text())]
start=next(i for i,e in enumerate(events) if e['event']=='next-level' and e['level']==2)
end=next(i for i,e in enumerate(events) if e['event']=='won' and e['level']==2)
dispatches=[e for e in events[start:end] if e['event']=='dispatch']
assert [e['vehicle'] for e in dispatches]==expected
slots=[next(b['slot'] for b in e['bays'] if b['id']==e['vehicle']) for e in dispatches]
reference_slots=[0,1,0,2,0,2,1,3,0,1,3,0]
assert slots==reference_slots,(slots,reference_slots)
text=(p/'e2e-runtime.log').read_text()
one=text[:text.index('"event":"won"')]
two=text[text.index('"event":"next-level","level":2'):text.index('"event":"won","level":2')]
for segment,ids,total in [(one,'B1 Y1 Y2 B2 R1 R2'.split(),240),(two,expected,480)]:
    counts=collections.defaultdict(list)
    for car,n,seats in re.findall(r'boarded (\w+) count=(\d+) remaining=(\d+)',segment):
        counts[car].append(int(seats));assert int(n)==sum(map(len,counts.values()))
    assert set(counts)==set(ids) and all(seq==list(range(39,-1,-1)) for seq in counts.values())
    assert len(re.findall(r'\] animate-board ',segment))==total
    active=peak=0
    for line in segment.splitlines():
        if '] animate-board ' in line:
            active+=1;peak=max(peak,active)
        elif '] boarded ' in line:active-=1
    assert active==0 and peak>1
    assert segment.count('belt-boost remaining=4')==1
    assert [int(i) for i in re.findall(r'belt-refill rider=(\d+)',segment)]==list(range(156,total))
    assert len(re.findall(r'vehicle-motion \w+ exit smoke=[1-9]',segment))==len(ids)
    assert len(re.findall(r'vehicle-motion \w+ enter smoke=[1-9]',segment))==len(ids)
assert text.count('victory-collection start coins=9')==2 and text.count('victory-reward {')==2
(p/'assertion.txt').write_text('true\n')
(p/'campaign-result.json').write_text(json.dumps({'wins':wins,'secondDispatch':expected,'secondBays':slots,'rewardBalances':[120,140],'fourBlockedCars':True,'pauseAndRestart':True},indent=2)+'\n')
PY
