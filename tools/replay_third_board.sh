# Continue from the actual second reward in the same Android process.
wait_log '[OwnedGameplay] level-playable 3' 1
sed -n 's/^.*\[OwnedGameplay\] tap-centers //p' "$proof/runtime-current.log" | tail -1 > "$proof/tap-centers.json"
cp "$proof/tap-centers.json" "$proof/third-centers.json"
capture third-grid
if [[ "$scenario" = third-failure-fixture ]]; then
  wait_log '[OwnedGameplay] passengers-in-ring 480 avatars=480' 2
  for car in C1 C17 C9 C19; do
    tap_car "$car"
    wait_log '"event":"parked","vehicle":"'"$car"'"' 1
  done
  wait_log '"event":"lost","level":3' 1
  capture third-lost
  adb -s "$serial" shell input tap 539 1414
  wait_log '"event":"restart","level":3' 1
  capture third-reset
  sed -nE 's/^.*\[OwnedGameplay\] (\{.*\})$/\1/p' "$proof/runtime-current.log" > "$proof/e2e.ndjson"
  jq -se '([.[] | select(.event=="lost") | [.level,.boarded,[.bays[].seatsLeft]]] == [[3,0,[40,40,16,16]]])
          and ([.[] | select(.event=="restart") | [.level,.boarded,.bays,(.ready|length)]] == [[3,0,[],22]])' "$proof/e2e.ndjson" > "$proof/assertion.txt"
  exit 0
fi
python3 - "$serial" "$pid" "$proof" <<'PY'
from pathlib import Path
import json,sys,subprocess,time
serial,pid,out=sys.argv[1:];out=Path(out)
def adb(*args):
    return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
logs=adb('logcat','-d','--pid='+pid,'-v','epoch')
zero=float(next(v.split()[0] for v in reversed(logs.splitlines()) if 'level-playable 3' in v))
origin=time.monotonic()-(float(adb('shell','date','+%s.%N'))-zero)
coords={v['id']:(v['x'],v['y']) for v in json.loads((out/'third-centers.json').read_text())['values']}
# Times in the source segment starting at 72 seconds. C2 first bumps C22, then leaves after C22.
taps=[(1,9.667),(0,11.133),(6,17.933),(19,21.2),(21,22.8),(5,25.4),(14,27.667),(20,29.8),
      (18,31.6),(3,33.8),(9,35.4),(12,38),(17,39.267),(16,42.267),(7,45.2),(11,52.2),
      (4,54),(8,57.267),(13,59.533),(23,61.533),(2,63),(22,63.4),(2,64.4)]
for vid,t in taps:
    time.sleep(max(0,origin+t-5.75-0.05-time.monotonic()))
    adb('shell','input','tap',*map(str,coords['C'+str(vid)]))
(out/'third-inputs.json').write_text(json.dumps(taps)+'\n')
PY
wait_log '"event":"won","level":3' 1
wait_log '[OwnedGameplay] victory-spine idle' 3
wait_log '[OwnedGameplay] rating-visible' 1
capture third-rating
adb -s "$serial" shell input tap 888 641
wait_log '[OwnedGameplay] rating-dismiss Btn_Close' 1
capture third-won
adb -s "$serial" shell 'input tap 543 1691; input tap 543 1691'
wait_log '[OwnedGameplay] victory-reward {"amount":20,"balance":160}' 1
capture third-reward
adb -s "$serial" shell input tap 543 1691
wait_log '"event":"restart","level":3' 1
tap_car C0
wait_log '[OwnedGameplay] contact C0 C1' 1
wait_log '[OwnedGameplay] returned C0' 1
tap_car C1
sleep 0.12
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 1
sleep 0.3
capture third-drive-paused-a
sleep 0.6
capture third-drive-paused-b
cmp "$proof/third-drive-paused-a.png" "$proof/third-drive-paused-b.png"
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] animate-board C1' 41
adb -s "$serial" shell input tap 1013 80
wait_log '[OwnedGameplay] pause' 2
paused=$(rg -cF '[OwnedGameplay] boarded ' "$proof/runtime-current.log")
sleep 0.65
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/paused-runtime.log"
test "$paused" = "$(rg -cF '[OwnedGameplay] boarded ' "$proof/paused-runtime.log")"
adb -s "$serial" shell input tap 67 80
wait_log '"event":"restart","level":3' 2
capture third-reset
adb -s "$serial" logcat -d --pid="$pid" -v raw > "$proof/e2e-runtime.log"
sed -nE 's/^.*\[OwnedGameplay\] (\{.*\})$/\1/p' "$proof/e2e-runtime.log" > "$proof/e2e.ndjson"
python3 - "$proof" <<'PY'
from pathlib import Path
import collections,json,re,sys
p=Path(sys.argv[1]); events=[json.loads(line) for line in (p/'e2e.ndjson').read_text().splitlines()]
wins=[(e['level'],e['boarded'],e['bays']) for e in events if e['event']=='won'];assert wins==[(1,240,[]),(2,480,[]),(3,480,[])],wins
text=(p/'e2e-runtime.log').read_text(); assert not any(e['event']=='lost' for e in events)
expected2=[r[0] for r in json.loads((p/'second-inputs.json').read_text())]
expected3=['C'+str(v) for v,t in json.loads((p/'third-inputs.json').read_text()) if not(v==2 and t==63)]
checks={}
for level,total,ids in [(1,240,'B1 Y1 Y2 B2 R1 R2'.split()),(2,480,expected2),(3,480,expected3)]:
    start=next(i for i,e in enumerate(events) if e['level']==level and e['event'] in ('enter','next-level'))
    end=next(i for i,e in enumerate(events) if e['level']==level and e['event']=='won')
    dispatch=[e for e in events[start:end] if e['event']=='dispatch']
    assert [e['vehicle'] for e in dispatch]==ids
    slots=[next(b['slot'] for b in e['bays'] if b['id']==e['vehicle']) for e in dispatch]
    if level==2:assert slots==[0,1,0,2,0,2,1,3,0,1,3,0],slots
    seg=text[text.index('"event":"'+('enter' if level==1 else 'next-level')+'","level":'+str(level)):text.index('"event":"won","level":'+str(level))]
    counts=collections.defaultdict(list)
    for car,n,left in re.findall(r'boarded (\w+) count=(\d+) remaining=(\d+)',seg):
        counts[car].append(int(left));assert int(n)==sum(map(len,counts.values()))
    assert set(counts)==set(ids)
    for car,left in counts.items():
        cap=40 if level<3 or car in ('C0','C1','C7','C16','C17') else 24 if car=='C2' else 16
        assert left==list(range(cap-1,-1,-1)),car
    active=peak=0
    for line in seg.splitlines():
        if '] animate-board ' in line:active+=1;peak=max(peak,active)
        elif '] boarded ' in line:active-=1
    assert active==0 and peak>1 and seg.count('] animate-board ')==total
    assert seg.count('belt-boost remaining=4')==1
    assert len(re.findall(r'vehicle-motion \w+ exit smoke=[1-9]',seg))==len(ids)
    assert len(re.findall(r'vehicle-motion \w+ enter smoke=[1-9]',seg))==len(ids)
    if level<3:
        assert [int(i) for i in re.findall(r'belt-refill rider=(\d+)',seg)]==list(range(156,total))
    else:
        assert '[OwnedGameplay] contact C2 C22' in seg
        admissions=[(int(a),int(b)) for a,b in re.findall(r'dual-admit first=(\d+) inlet=(\d+)',seg)]
        assert sorted(a for a,b in admissions)==list(range(0,480,4))
        assert collections.Counter(b for a,b in admissions)=={0:69,276:51}
    checks[level]={'boarded':total,'slots':slots,'peakInTransit':peak,'counts':{k:len(v) for k,v in counts.items()}}
assert any(e['event']=='parked' and e.get('vehicle')=='Y1' and 0<e['boarded']<40 and any(b['id']=='B1' and b['stage']=='parked' for b in e['bays']) for e in events)
assert [e['vehicle'] for e in events if e['level']==2 and e['event']=='contact-return']==['V1','O1','V3','G2']
assert text.count('rating-visible')==1 and text.count('rating-dismiss Btn_Close')==1
assert text.count('victory-reward {')==text.count('victory-collection start coins=9')==3
assert all(e['ready'] and len(e['ready'])==22 and not e['bays'] and e['boarded']==0 for e in events if e['event']=='restart')
(p/'assertion.txt').write_text('true\n')
(p/'campaign-result.json').write_text(json.dumps({'wins':wins,'checks':checks,'rewardBalances':[120,140,160]},indent=2)+'\n')
PY
