"""Export the APK victory panel's animation, coin sprites and a baked UI particle burst."""

import argparse
import itertools
import json
import math
import random
import struct
import zlib
from pathlib import Path

from export_result_panels import restore_sprite_rect
from inspect_art import BUNDLES, component_pointer, load_environment, object_id
from PIL import Image, ImageOps

FPS = 30
TILE = 184
EXTENT = 1100
BURST_FRAMES = 24


def components(game_object):
    return [
        component_pointer(item).deref()
        for item in game_object.parse_as_object().m_Component
    ]


def paths(reader, path=""):
    yield path, reader
    transform = next(
        c for c in components(reader) if c.type.name in ("Transform", "RectTransform")
    )
    for child in transform.parse_as_object().m_Children:
        go = child.deref().parse_as_object().m_GameObject.deref()
        yield from paths(go, (path + "/" + go.parse_as_object().m_Name).lstrip("/"))


def clip_tracks(clip, path_names):
    data = clip["m_MuscleClip"]["m_Clip"]["data"]
    stream = data["m_StreamedClip"]
    words = stream["data"]
    raw = struct.pack(f"<{len(words)}I", *words)
    curves = [[] for _ in range(stream["curveCount"])]
    offset = 0
    while offset < len(raw):
        time, count = struct.unpack_from("<fI", raw, offset)
        offset += 8
        for _ in range(count):
            index, *coefficients = struct.unpack_from("<i4f", raw, offset)
            offset += 20
            curves[index].append((time, coefficients))
    if data["m_DenseClip"]["m_CurveCount"]:
        raise ValueError("Victory clips must contain streamed or constant tracks")
    for value in data["m_ConstantClip"]["data"]:
        curves.append([(0, [0, 0, 0, value])])
    lookup = {zlib.crc32(name.encode()): name for name in path_names}
    result = {}
    index = 0
    for binding in clip["m_ClipBindingConstant"]["genericBindings"]:
        kind, prop = binding["typeID"], binding["attribute"]
        width = 3 if kind == 4 and prop == 3 else 1
        name = lookup.get(binding["path"])
        if name is not None:
            result[name, kind, prop] = curves[index]
        index += width
    assert index == len(curves)
    return result


def value_at(keys, time):
    before = next((key for key in reversed(keys) if key[0] <= time + 1e-6), keys[0])
    start, (a, b, c, d) = before
    t = max(0, time - start) if start > -1000 else 0
    return ((a * t + b) * t + c) * t + d


def samples(keys, duration):
    return [
        round(value_at(keys, i / FPS), 3) for i in range(math.ceil(duration * FPS) + 1)
    ]


def animate_clip(node, name):
    animator = next(
        c.parse_as_object() for c in components(node) if c.type.name == "Animator"
    )
    clips = animator.m_Controller.deref().parse_as_object().m_AnimationClips
    return next(
        p.deref().read_typetree()
        for p in clips
        if p.deref().parse_as_object().m_Name == name
    )


def curve_value(curve, t):
    keys = curve["maxCurve"]["m_Curve"]
    if not keys or curve["minMaxState"] == 0:
        return curve["scalar"]
    if t <= keys[0]["time"]:
        return keys[0]["value"] * curve["scalar"]
    for a, b in itertools.pairwise(keys):
        if t <= b["time"]:
            span = b["time"] - a["time"]
            u = (t - a["time"]) / span
            return curve["scalar"] * (
                (2 * u**3 - 3 * u * u + 1) * a["value"]
                + (u**3 - 2 * u * u + u) * span * a["outSlope"]
                + (3 * u * u - 2 * u**3) * b["value"]
                + (u**3 - u * u) * span * b["inSlope"]
            )
    return keys[-1]["value"] * curve["scalar"]


def number(param, rng):
    return (
        rng.uniform(param["minScalar"], param["scalar"])
        if param["minMaxState"] == 3
        else param["scalar"]
    )


def gradient_value(g, t, channel):
    alpha = channel == "a"
    prefix = "atime" if alpha else "ctime"
    count = g["m_NumAlphaKeys" if alpha else "m_NumColorKeys"]
    points = [
        (g[prefix + str(i)] / 65535, g["key" + str(i)][channel]) for i in range(count)
    ]
    for (ta, a), (tb, b) in itertools.pairwise(points):
        if t <= tb and tb > ta:
            return a + (b - a) * max(0, (t - ta) / (tb - ta))
    return points[-1][1]


def tint(image, color):
    channels = [
        ch.point([round(v * max(0, min(1, c))) for v in range(256)])
        for ch, c in zip(image.split(), color)
    ]
    return Image.merge("RGBA", channels)


def stamp(canvas, image, x, y, w, h, color, angle=0):
    if min(w, h) < 0.5 or color[3] <= 0:
        return
    img = tint(image, color).resize(
        (max(1, round(w)), max(1, round(h))), Image.Resampling.BILINEAR
    )
    if angle:
        img = img.rotate(angle, Image.Resampling.BICUBIC, expand=True)
    canvas.alpha_composite(img, (round(x - img.width / 2), round(y - img.height / 2)))


def bake_firework(prefab):
    rng = random.Random(19)
    particles = []
    for path, go in paths(prefab):
        if path.rsplit("/", 1)[-1] not in (
            "Boom",
            "Star",
            "SmallStarTrail",
            "RoundTrail",
        ):
            continue
        comp = components(go)
        system = next(
            c.read_typetree() for c in comp if c.type.name == "ParticleSystem"
        )
        renderer = next(
            c.parse_as_object() for c in comp if c.type.name == "ParticleSystemRenderer"
        )
        textures = []
        for mat in renderer.m_Materials:
            textures.append(
                next(
                    tex.m_Texture.deref().parse_as_object().image.convert("RGBA")
                    for key, tex in mat.deref()
                    .parse_as_object()
                    .m_SavedProperties.m_TexEnvs
                    if key == "_MainTex"
                )
            )
        initial = system["InitialModule"]
        for _ in range(
            int(system["EmissionModule"]["m_Bursts"][0]["countCurve"]["scalar"])
        ):
            angle = rng.uniform(0, 2 * math.pi)
            projection = math.sqrt(1 - rng.uniform(-1, 1) ** 2)
            speed = number(initial["startSpeed"], rng)
            life = number(initial["startLifetime"], rng)
            size = number(initial["startSize"], rng)
            start = initial["startColor"]
            grad_pos = rng.random()
            color = tuple(
                gradient_value(start["maxGradient"], grad_pos, c)
                if start["minMaxState"] == 4
                else start["maxColor"][c]
                for c in "rgb"
            ) + (start["maxColor"]["a"],)
            vx, vy = (
                speed * projection * math.cos(angle),
                speed * projection * math.sin(angle),
            )
            clamp = system["ClampVelocityModule"]
            limit = number(clamp["magnitude"], rng)
            positions = [(0.0, 0.0)]
            for i in range(1, BURST_FRAMES * 2):
                dt = 1 / (FPS * 2)
                vy -= (
                    9.81
                    * curve_value(initial["gravityModifier"], min(1, i * dt / life))
                    * dt
                )
                length = math.hypot(vx, vy)
                if clamp["enabled"] and length > limit:
                    factor = 1 - clamp["dampen"] * (length - limit) / length
                    vx, vy = vx * factor, vy * factor
                x, y = positions[-1]
                positions.append((x + vx * dt, y + vy * dt))
            particles.append((textures, system, life, size, color, positions))
    atlas = Image.new("RGBA", (6 * TILE, 4 * TILE))
    scale = TILE / EXTENT
    for frame in range(BURST_FRAMES):
        tile = Image.new("RGBA", (TILE, TILE))
        for textures, system, life, size, color, positions in particles:
            t = frame / FPS / life
            if t >= 1:
                continue
            idx = frame * 2
            x, y = positions[idx]
            px, py = TILE / 2 + x * scale, TILE * 0.38 - y * scale
            width = size * curve_value(system["SizeModule"]["curve"], t) * scale
            alpha = gradient_value(
                system["ColorModule"]["gradient"]["maxGradient"], t, "a"
            )
            rgba = (*color[:3], color[3] * alpha)
            if len(textures) > 1 and idx > 0:
                tail_age = curve_value(system["TrailModule"]["lifetime"], t) * life
                ox, oy = positions[max(0, idx - round(tail_age * FPS * 2))]
                dx, dy = (x - ox) * scale, (y - oy) * scale
                stamp(
                    tile,
                    ImageOps.mirror(textures[1]),
                    px - dx / 2,
                    py + dy / 2,
                    math.hypot(dx, dy),
                    width * system["TrailModule"]["widthOverTrail"]["scalar"] * 0.65,
                    rgba,
                    math.degrees(math.atan2(dy, dx)),
                )
            stamp(tile, textures[0], px, py, width, width, rgba)
        atlas.paste(tile, (frame % 6 * TILE, frame // 6 * TILE))
    return atlas


def export(apk, destination):
    BUNDLES.add("effects")
    env = load_environment(apk)

    def prefab(suffix):
        return next(
            p.deref()
            for k, p in env.container.items()
            if k.endswith("/" + suffix + ".prefab")
        )

    dest = Path(destination)
    dest.mkdir(parents=True, exist_ok=True)
    victory = dict(paths(prefab("victorypanel")))["All_Empty"]
    nodes = dict(paths(victory))
    tracks = clip_tracks(animate_clip(victory, "Effect_VictoryPanel_In"), nodes)
    emitters = []
    for path, go in nodes.items():
        if not path.startswith("Fireworks/") or path.count("/") != 1:
            continue
        tr = next(
            c.parse_as_object()
            for c in components(go)
            if c.type.name == "RectTransform"
        )
        keys = tracks[path, 1, 2086281974]
        emitters.append(
            [
                tr.m_AnchoredPosition.x,
                tr.m_AnchoredPosition.y,
                tr.m_LocalScale.x,
                round(next(t for t, v in keys if t >= 0 and v[-1] > 0.5), 4),
            ]
        )
    effect = prefab("effect_fireworks")
    bake_firework(effect).save(dest / "victory-fireworks.png")
    gold = dict(paths(prefab("effect_gold_collect")))["All_Anim"]
    coins = dict(paths(gold))
    clip = animate_clip(gold, "Effect_Gold_Collect")
    gold_tracks = clip_tracks(clip, coins)
    scatter = []
    for i in range(1, 10):
        name = f"Gold_{i:02d}"
        scatter.append(
            [
                round(value_at(gold_tracks[name, 224, prop], 1.5), 2)
                for prop in (1460864421, 538195251)
            ]
        )

    def main_texture(go):
        renderer = next(
            c.parse_as_object()
            for c in components(go)
            if c.type.name == "ParticleSystemRenderer"
        )
        material = renderer.m_Materials[0].deref().parse_as_object()
        return next(
            t.m_Texture.deref()
            for key, t in material.m_SavedProperties.m_TexEnvs
            if key == "_MainTex"
        )

    gold_tex = main_texture(coins["Gold_01/Gold"])
    gold_tex.parse_as_object().image.save(dest / "victory-coin-spin.png")
    star = coins["Gold_01/Gold/Star"]
    star_tex = main_texture(star)
    star_tex.parse_as_object().image.save(dest / "victory-coin-glint.png")
    star_system = next(
        c.read_typetree() for c in components(star) if c.type.name == "ParticleSystem"
    )
    star_initial = star_system["InitialModule"]
    icon = next(
        r
        for r in env.objects
        if r.type.name == "Sprite" and r.parse_as_object().m_Name == "Main_Victory_Gold"
    )
    sprite = icon.parse_as_object()
    reward, _ = restore_sprite_rect(
        sprite, (round(sprite.m_Rect.width), round(sprite.m_Rect.height))
    )
    reward.save(dest / "victory-small-reward.png")
    data = {
        "fps": FPS,
        "title": samples(tracks["Title_Img", 4, 3], 0.4),
        "reward": samples(tracks["Gold_Img", 4, 3], 0.87),
        "buttonY": samples(tracks["Btn_Group", 224, 538195251], 0.8),
        "emitters": emitters,
        "scatter": scatter,
        "rewardSize": list(reward.size),
        "glintLife": star_initial["startLifetime"]["scalar"],
        "glintSpacing": 1 / star_system["EmissionModule"]["rateOverDistance"]["scalar"],
        "glintColor": [
            round(255 * star_initial["startColor"]["maxColor"][c]) for c in "rgb"
        ],
        "fireworkExtent": EXTENT,
        "fireworkAnchorY": 0.62,
        "fireworkFrames": BURST_FRAMES,
        "sources": {
            "fireworks": object_id(effect),
            "coin": object_id(gold_tex),
            "coinGlint": object_id(star_tex),
            "reward": object_id(icon),
        },
    }
    (dest / "victory-motion.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps(data["sources"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk")
    parser.add_argument("destination")
    args = parser.parse_args()
    export(args.apk, args.destination)
