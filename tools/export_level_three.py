"""Import the shared A/B third round from its serialized level object and original APK art."""

import argparse
import collections
import itertools
import json
import math
import subprocess
import tempfile
from pathlib import Path

from export_level_two_art import components, export_title, walk
from export_result_panels import restore_sprite_rect
from inspect_art import load_environment, object_id
from PIL import Image
from UnityPy.classes.PPtr import PPtr


def xyz(v):
    return [v.x, v.y, v.z]


def pose(tr):
    return {
        "position": xyz(tr.m_LocalPosition),
        "rotation": [*xyz(tr.m_LocalRotation), tr.m_LocalRotation.w],
        "scale": xyz(tr.m_LocalScale),
    }


def glb(mesh, filename):
    with tempfile.TemporaryDirectory() as directory:
        obj = Path(directory) / (filename.stem + ".obj")
        obj.write_text(mesh.parse_as_object().export())
        subprocess.run(
            ["assimp", "export", str(obj), str(filename.resolve()), "-fglb2"],
            stdout=subprocess.DEVNULL,
            check=True,
        )


def sliced(image, size, border):
    if not any(border):
        return image.resize(size, Image.Resampling.LANCZOS)
    left, bottom, right, top = border

    def grid(length, a, b):
        scale = min(1, length / max(1, a + b))
        return [0, round(a * scale), length - round(b * scale), length]

    xs = grid(image.width, left, right)
    ys = grid(image.height, top, bottom)
    dx = grid(size[0], left, right)
    dy = grid(size[1], top, bottom)
    result = Image.new("RGBA", size)
    for i in range(3):
        for j in range(3):
            w, h = dx[i + 1] - dx[i], dy[j + 1] - dy[j]
            if w and h and xs[i + 1] > xs[i] and ys[j + 1] > ys[j]:
                result.paste(
                    image.crop((xs[i], ys[j], xs[i + 1], ys[j + 1])).resize(
                        (w, h), Image.Resampling.LANCZOS
                    ),
                    (dx[i], dy[j]),
                )
    return result


def rating_art(root, out):
    canvas = Image.new("RGBA", (900, 1220))
    labels = {}
    buttons = {}

    def visit(r, x, y, sx, sy):
        go = r.parse_as_object()
        if not go.m_IsActive:
            return
        parts = components(r)
        tr = next(
            c.parse_as_object()
            for c in parts
            if c.type.name in ("Transform", "RectTransform")
        )
        if not hasattr(tr, "m_AnchoredPosition"):
            return
        name = go.m_Name
        if name != "All_Anim":
            x += tr.m_AnchoredPosition.x * sx
            y += tr.m_AnchoredPosition.y * sy
            sx *= tr.m_LocalScale.x
            sy *= tr.m_LocalScale.y
        w = max(1, round(abs(tr.m_SizeDelta.x * sx)))
        h = max(1, round(abs(tr.m_SizeDelta.y * sy)))
        if name in ("Btn_Close", "Btn_Yellow", "Btn_Green"):
            buttons[name] = [round(x), round(y), w, h]
        for c in parts:
            if c.type.name != "MonoBehaviour":
                continue
            t = c.read_typetree()
            if not t.get("m_Enabled", 1):
                continue
            if name in ("Title_Text", "Content_Text") and "m_text" in t:
                labels[name] = {
                    "text": t["m_text"],
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "font": t["m_fontSize"],
                }
            sprite = t.get("m_Sprite", {})
            if not sprite.get("m_PathID") or not t.get("m_Color", {}).get("a", 1):
                continue
            asset = PPtr(**sprite, assetsfile=c.assets_file).deref().parse_as_object()
            im, _ = restore_sprite_rect(
                asset, (round(asset.m_Rect.width), round(asset.m_Rect.height))
            )
            border = (
                [round(getattr(asset.m_Border, k)) for k in "xyzw"]
                if t.get("m_Type") == 1
                else [0] * 4
            )
            im = sliced(im, (w, h), border)
            color = t["m_Color"]
            im = Image.merge(
                "RGBA",
                [
                    ch.point([min(255, round(i * color[k])) for i in range(256)])
                    for ch, k in zip(im.split(), "rgba")
                ],
            )
            canvas.alpha_composite(
                im,
                (
                    round(canvas.width / 2 + x - w / 2),
                    round(canvas.height / 2 - y - h / 2),
                ),
            )
        for child in tr.m_Children:
            visit(child.deref().parse_as_object().m_GameObject.deref(), x, y, sx, sy)

    anim = next(
        tr.m_GameObject.deref() for name, tr, _ in walk(root) if name == "All_Anim"
    )
    visit(anim, 0, 0, 1, 1)
    canvas.save(out / "third-rating.png")
    return {"labels": labels, "buttons": buttons, "prefab": object_id(root)}


def board_data(config):
    if "fleet" in config and "streams" in config:
        # The checked-in projection can be reused when rebuilding just the original art.
        return config["fleet"], config["streams"]
    assert (
        config["id"] == 3
        and config["passengerMethod"] == 4
        and config["conveyorBeltName"] == "ConveyorBelt2"
    )
    routes = {0: "teal", 4: "red", 5: "amber"}
    fleet = []
    for v in config["vehicles"]:
        assert v["containerType"] == 1 and not v["isHidden"] and not v["isTurnVehicle"]
        q = v["rotation"]
        pos = v["position"]
        assert q["x"] == q["z"] == 0 and pos["y"] == 0
        fleet.append(
            {
                "id": "C" + str(v["id"]),
                "route": routes[v["colorIndex"]],
                "groups": v["seats"],
                "x": pos["x"],
                "z": pos["z"],
                "yaw": -math.degrees(2 * math.atan2(q["y"], q["w"])),
            }
        )
    streams = []
    for inlet in (0, 1):
        order = [
            routes[g["colorIndex"]]
            for g in config["fixedPassengerSequence"]
            if g["queueId"] == inlet
        ]
        streams.append(
            [[route, 4 * len(list(group))] for route, group in itertools.groupby(order)]
        )
    return fleet, streams


def export(apk, level_path, destination):
    destination.mkdir(exist_ok=True, parents=True)
    env = load_environment(apk)

    def prefab(name):
        return next(
            p.deref()
            for k, p in env.container.items()
            if k.endswith("/" + name + ".prefab")
        )

    config = json.loads(level_path.read_text())
    fleet, streams = board_data(config)
    seats = collections.Counter()
    riders = collections.Counter()
    for v in fleet:
        seats[v["route"]] += 4 * v["groups"]
    for queue in streams:
        for route, count in queue:
            riders[route] += count
    assert seats == riders and sum(seats.values()) == 480
    assert {v["groups"] for v in fleet} == {4, 6, 10}
    sources = {}
    shapes = {}
    for groups in (4, 6, 10):
        root = prefab("bus_normal_" + str(groups))
        nodes = list(walk(root))
        whole = next((tr, parts) for name, tr, parts in nodes if name == "Whole")
        box = next(
            c.parse_as_object() for c in whole[1] if c.type.name == "BoxCollider"
        )
        arrow = next(tr for name, tr, parts in nodes if name == "Arrow_01")
        shapes[str(groups)] = {
            "scale": xyz(whole[0].m_LocalScale),
            "boxSize": xyz(box.m_Size),
            "boxCenter": xyz(box.m_Center),
            "arrow": pose(arrow),
        }
        ids = {"prefab": object_id(root)}
        for name, key in [
            ("Bus_001", "body"),
            ("Wheel_001", "wheel"),
            ("Bus_FakeShadow", "shadow"),
        ]:
            parts = next(parts for n, tr, parts in nodes if n == name)
            mesh = next(
                c.parse_as_object().m_Mesh.deref()
                for c in parts
                if c.type.name == "MeshFilter"
            )
            ids[key] = object_id(mesh)
            if groups == 6:
                glb(mesh, destination / ("van-" + key + ".glb"))
                if key == "shadow":
                    mat = next(
                        c.parse_as_object().m_Materials[0].deref()
                        for c in parts
                        if c.type.name == "MeshRenderer"
                    )
                    tex = next(
                        t.m_Texture.deref()
                        for k, t in mat.parse_as_object().m_SavedProperties.m_TexEnvs
                        if k == "_MainTex"
                    )
                    tex.parse_as_object().image.save(destination / "van-shadow-map.png")
                    ids["shadowMap"] = object_id(tex)
        sources["bus" + str(groups)] = ids
    belt = prefab("conveyorbelt2")
    nodes = list(walk(belt))
    belt_tr = nodes[0][1]
    sprite_tr, parts = next((tr, parts) for n, tr, parts in nodes if n == "Loop_02")
    sprite = next(
        c.parse_as_object().m_Sprite.deref()
        for c in parts
        if c.type.name == "SpriteRenderer"
    )
    spr = sprite.parse_as_object()
    spr.image.save(destination / "level-three-conveyor.png")
    off = spr.m_RD.textureRectOffset
    rect = spr.m_RD.textureRect
    ppu = spr.m_PixelsToUnits
    x = off.x - spr.m_Pivot.x * spr.m_Rect.width
    y = off.y - spr.m_Pivot.y * spr.m_Rect.height
    road = {
        "root": pose(belt_tr),
        "sprite": pose(sprite_tr),
        "bounds": [x / ppu, y / ppu, (x + rect.width) / ppu, (y + rect.height) / ppu],
    }
    scripts = {}
    for name, tr, parts in nodes:
        for c in parts:
            if c.type.name == "MonoBehaviour":
                scripts[name] = c.read_typetree()

    def points(key):
        return [[v["position"][c] for c in "xyz"] for v in scripts[key]["_rawSamples"]]

    b = scripts["ConveyorBelt"]
    queue = {
        "ring": points("ConveyorBeltPtah"),
        "entry": points("LeftQueuePath"),
        "otherEntry": points("RightQueuePath"),
        "capacity": b["capacity"],
        "spacing": scripts["Queue_Left"]["spacing"],
        "exitStartPercent": b["exitStartPercent"],
        "exitEndPercent": b["exitEndPercent"],
        "exitPercent": (b["exitStartPercent"] + b["exitEndPercent"]) / 2,
    }
    sources.update(
        belt=object_id(belt),
        sprite=object_id(sprite),
        font=export_title(
            prefab("gamepanel"), 3, destination / "level-three-title.png"
        ),
    )
    data = {
        "fleet": fleet,
        "streams": streams,
        "mapScale": config["mapScale"],
        "shapes": shapes,
        "conveyor": road,
        "queue": queue,
        "sources": sources,
    }
    data["rating"] = rating_art(prefab("lastrateguidepanel"), destination)
    (destination / "level-three.json").write_text(
        json.dumps(data, separators=(",", ":")) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("apk", "level", "destination"):
        parser.add_argument(arg, type=Path)
    args = parser.parse_args()
    export(args.apk, args.level, args.destination)
