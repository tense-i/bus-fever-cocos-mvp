"""Export the second level's original skins, sky transition and HUD glyphs."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from export_game_hud import alpha_mask
from export_result_panels import restore_sprite_rect
from inspect_art import BUNDLES, component_pointer, load_environment, object_id
from PIL import Image
from UnityPy.classes.PPtr import PPtr


def components(reader):
    return [
        component_pointer(pair).deref() for pair in reader.parse_as_object().m_Component
    ]


def walk(reader):
    parts = components(reader)
    transform = next(
        r.parse_as_object()
        for r in parts
        if r.type.name in ("Transform", "RectTransform")
    )
    yield reader.parse_as_object().m_Name, transform, parts
    for child in transform.m_Children:
        yield from walk(child.deref().parse_as_object().m_GameObject.deref())


def rgba(c):
    return [getattr(c, channel) for channel in "rgba"]


def export(apk, out):
    out.mkdir(parents=True, exist_ok=True)
    BUNDLES.add("effects")
    env = load_environment(apk)
    objects = list(env.objects)
    materials = {
        r.parse_as_object().m_Name: r for r in objects if r.type.name == "Material"
    }

    def prefab(name):
        return next(
            p.deref()
            for k, p in env.container.items()
            if k.endswith("/" + name + ".prefab")
        )

    art = {"cars": {}, "riders": {}, "sources": {}}
    for route in ("purple", "orange", "green", "pink"):
        car = materials["Car_" + route + "_new"]
        props = car.parse_as_object().m_SavedProperties
        tex = next(v.m_Texture.deref() for k, v in props.m_TexEnvs if k == "_MainTex")
        tex.parse_as_object().image.save(out / ("bus-" + route + "-map.png"))
        floats, colors = dict(props.m_Floats), dict(props.m_Colors)
        art["cars"][route] = {
            "diffuse": [
                floats[k]
                for k in (
                    "_DiffuseWrap",
                    "_DiffuseStrength",
                    "_DiffuseContrast",
                    "_Gloss",
                )
            ],
            "specular": floats["_SpecStrength"],
            "baseColor": rgba(colors["_BaseCol"]),
            "emissionColor": rgba(colors["_EmissionCol"]),
        }
        rider = prefab("passenger_" + route)
        for _, _, parts in walk(rider):
            for r in parts:
                if (
                    r.type.name == "MonoBehaviour"
                    and r.parse_as_object().m_Script.deref().parse_as_object().m_Name
                    == "VertexAnimation"
                ):
                    tree = r.read_typetree()
                    mesh = next(
                        c.parse_as_object().m_Mesh.deref()
                        for c in parts
                        if c.type.name == "MeshFilter"
                    )
                    material = next(
                        c.parse_as_object().m_Materials[0].deref()
                        for c in parts
                        if c.type.name == "MeshRenderer"
                    )
                    assert (
                        mesh.parse_as_object().m_Name == "Idle_boy01"
                        and material.parse_as_object().m_Name == "Idle_passenger"
                    )
                    art["riders"][route] = [tree["m_BaseColor"][k] for k in "rgba"]
                    art["sources"][route] = {
                        "paint": object_id(car),
                        "texture": object_id(tex),
                        "prefab": object_id(rider),
                        "animation": object_id(r),
                        "mesh": object_id(mesh),
                        "material": object_id(material),
                    }
    ad = next(
        r
        for r in objects
        if r.type.name == "GameObject" and r.parse_as_object().m_Name == "PS_AD_1"
    )
    parts = next(parts for name, _, parts in walk(ad) if name == "Add")
    addmesh = next(
        c.parse_as_object().m_Mesh.deref() for c in parts if c.type.name == "MeshFilter"
    )
    admat = next(
        c.parse_as_object().m_Materials[0].deref()
        for c in parts
        if c.type.name == "MeshRenderer"
    )
    adtex = next(
        t.m_Texture.deref()
        for k, t in admat.parse_as_object().m_SavedProperties.m_TexEnvs
        if k == "_MainTex"
    )
    art["sources"]["adSlot"] = [object_id(r) for r in (ad, addmesh, admat, adtex)]
    adtex.parse_as_object().image.save(out / "parking-ad-map.png")
    with tempfile.TemporaryDirectory() as tmp:
        obj = Path(tmp) / "parking-add.obj"
        obj.write_text(addmesh.parse_as_object().export())
        subprocess.run(
            [
                "assimp",
                "export",
                str(obj),
                str((out / "parking-add.glb").resolve()),
                "-fglb2",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    sky = prefab("effect_skytransition")
    art["sources"]["sky"] = object_id(sky)
    sprites = {}
    for name, tr, parts in walk(sky):
        for r in parts:
            if (
                r.type.name != "MonoBehaviour"
                or r.parse_as_object().m_Script.deref().parse_as_object().m_Name
                != "Image"
            ):
                continue
            sprite = r.assets_file.objects[
                r.read_typetree()["m_Sprite"]["m_PathID"]
            ].parse_as_object()
            im, _ = restore_sprite_rect(
                sprite, (round(sprite.m_Rect.width), round(sprite.m_Rect.height))
            )
            sprites[name] = (im, tr)
    # Bake the static sky layers at half the prefab's portrait design resolution.
    canvas = sprites["Img_Bg"][0].resize((540, 1080), Image.Resampling.LANCZOS)
    for name, (im, tr) in sprites.items():
        if "Yun" not in name:
            continue
        x = 540 * tr.m_AnchorMin.x + 0.5 * tr.m_AnchoredPosition.x
        y = 1080 * (1 - tr.m_AnchorMin.y) - 0.5 * tr.m_AnchoredPosition.y
        im = im.resize(
            (
                round(0.5 * tr.m_SizeDelta.x * tr.m_LocalScale.x),
                round(0.5 * tr.m_SizeDelta.y * tr.m_LocalScale.y),
            ),
            Image.Resampling.LANCZOS,
        )
        canvas.alpha_composite(im, (round(x - im.width / 2), round(y - im.height / 2)))
    canvas.save(out / "transition-sky.png")
    trail_parts = next(
        parts for name, _, parts in walk(sky) if name == "Particle System"
    )
    trail_material = next(
        c.parse_as_object().m_Materials[0].deref()
        for c in trail_parts
        if c.type.name == "ParticleSystemRenderer"
    )
    trail = next(
        t.m_Texture.deref()
        for key, t in trail_material.parse_as_object().m_SavedProperties.m_TexEnvs
        if key == "_MainTex"
    )
    art["sources"]["aircraftTrail"] = object_id(trail)
    dot = trail.parse_as_object().image.convert("RGBA")
    plane = Image.new("RGBA", (165, 109))
    for i in range(54):
        fraction = i / 53
        size = round(2 + fraction * 4)
        puff = dot.resize((size, size), Image.Resampling.LANCZOS)
        puff.putalpha(
            puff.getchannel("A").point(
                lambda a, opacity=0.18 + 0.48 * fraction: round(a * opacity)
            )
        )
        plane.alpha_composite(
            puff, (round(122 * fraction), round(104 - 77 * fraction + (i % 3) - 1))
        )
    plane.alpha_composite(sprites["Img_Feiji"][0], (110, 0))
    plane.save(out / "transition-plane.png")
    art["sources"]["font"] = export_title(
        prefab("gamepanel"), 2, out / "level-two-title.png"
    )
    (out / "level-two-art.json").write_text(json.dumps(art, indent=2) + "\n")


def export_title(panel, level, output):
    # The level header and the locked booster labels share the same node name.
    # Resolve the top HUD branch explicitly to pick the header's material and size.
    for segment in ("All_Empty", "Top_Empty", "Level_Text"):
        transform = next(
            c.parse_as_object()
            for c in components(panel)
            if c.type.name == "RectTransform"
        )
        panel = next(
            ch.deref().parse_as_object().m_GameObject.deref()
            for ch in transform.m_Children
            if ch.deref()
            .parse_as_object()
            .m_GameObject.deref()
            .parse_as_object()
            .m_Name
            == segment
        )
    _, rect, parts = next(walk(panel))
    tmp = next(
        r
        for r in parts
        if r.type.name == "MonoBehaviour" and "m_fontAsset" in r.read_typetree()
    )
    config = tmp.read_typetree()

    def resolve(owner, spec):
        return PPtr(**spec, assetsfile=owner.assets_file).deref()

    font = resolve(tmp, config["m_fontAsset"])
    font_data = font.read_typetree()
    atlas_reader = resolve(font, font_data["m_AtlasTextures"][0])
    atlas = atlas_reader.parse_as_object().image.getchannel("A")
    mat = resolve(tmp, config["m_sharedMaterial"]).parse_as_object().m_SavedProperties
    pick = {
        "characters": font_data["m_CharacterTable"],
        "glyphs": font_data["m_GlyphTable"],
        "material": {
            "floats": dict(mat.m_Floats),
            "colors": {k: rgba(v) for k, v in mat.m_Colors},
        },
    }
    source = {"config": config, "fontData": font_data, "fontId": object_id(font)}
    size = (round(rect.m_SizeDelta.x), round(rect.m_SizeDelta.y))
    text = source["config"]["m_text"].format(level)
    params = pick["material"]["floats"]
    shadow = alpha_mask(
        atlas,
        source,
        pick,
        text,
        size,
        1 + params["_UnderlaySoftness"],
        params["_UnderlayDilate"] * 0.5,
        [params["_UnderlayOffsetX"], params["_UnderlayOffsetY"]],
    )
    face = alpha_mask(
        atlas, source, pick, text, size, 1, params["_FaceDilate"] * 0.5, [0, 0]
    )
    label = Image.new(
        "RGBA",
        size,
        tuple(round(255 * x) for x in pick["material"]["colors"]["_UnderlayColor"]),
    )
    label.putalpha(shadow)
    fill = Image.new(
        "RGBA",
        size,
        tuple(round(255 * source["config"]["m_fontColor"][k]) for k in "rgba"),
    )
    fill.putalpha(face)
    Image.alpha_composite(label, fill).save(output)
    return source["fontId"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("apk", "output"):
        parser.add_argument(key, type=Path)
    args = parser.parse_args()
    export(args.apk, args.output)
