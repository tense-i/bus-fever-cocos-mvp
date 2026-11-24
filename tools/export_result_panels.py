import hashlib
import json
import pathlib
import sys
from inspect_art import load_environment, object_id
from PIL import Image

SELECTED = {
    "won": [
        ("victory-title", "/VictoryPanel/All_Empty/Title_Img"),
        ("victory-coins", "/VictoryPanel/All_Empty/Gold_Img"),
    ],
    "lost": [
        ("failure-board", "/FailPanel/SafeArea/All_Anim/Revive_Empty/Board_Bg"),
        ("failure-inner", "/FailPanel/SafeArea/All_Anim/Revive_Empty/MidBg_Img"),
        ("failure-heart", "/FailPanel/SafeArea/All_Anim/Revive_Empty/MidBg_Img/Heart_Img"),
    ],
}


def centered_coordinates(path, nodes):
    position = [0.0, 0.0]
    cursor = path
    while cursor:
        node = nodes[cursor]
        rect = node["rect"]
        if any(abs(value - 0.5) > 1e-6 for value in rect["m_Pivot"]) or node["scale"] != [1, 1, 1]:
            raise ValueError(f"Unexpected RectTransform for {cursor}")
        if node["rotation"] != [0, 0, 0, 1]:
            raise ValueError(f"Rotation needs explicit handling for {cursor}")
        anchors = (rect["m_AnchorMin"], rect["m_AnchorMax"])
        if anchors not in (([0.5, 0.5], [0.5, 0.5]), ([0, 0], [1, 1])):
            raise ValueError(f"Selected node is not centered or stretched: {cursor}")
        position = [a + b for a, b in zip(position, rect["m_AnchoredPosition"])]
        cursor = cursor.rsplit("/", 1)[0]
    return position


def restore_sprite_rect(sprite, size):
    cropped = sprite.image.convert("RGBA")
    if cropped.size == size:
        return cropped, [0, 0]
    offset = sprite.m_RD.textureRectOffset
    if sprite.m_SpriteAtlas.m_PathID:
        atlas = sprite.m_SpriteAtlas.deref().parse_as_object()
        item = next((item for key, item in atlas.m_RenderDataMap if key == sprite.m_RenderDataKey), None)
        if item is not None:
            offset = item.textureRectOffset
    x = round(offset.x)
    y = size[1] - round(offset.y) - cropped.height
    if x < 0 or y < 0 or x + cropped.width > size[0] or y + cropped.height > size[1]:
        raise ValueError(f"Sprite crop exceeds its source rectangle: {sprite.m_Name}")
    canvas = Image.new("RGBA", size)
    canvas.paste(cropped, (x, y))
    return canvas, [x, y]


def export(apk, layout, destination):
    env = load_environment(apk)
    readers = {object_id(reader): reader for reader in env.objects if reader.type.name == "Sprite"}
    report = {}
    for state, assets in SELECTED.items():
        panel = layout["victorypanel.prefab" if state == "won" else "failpanel.prefab"]
        nodes = {node["path"]: node for node in panel["nodes"]}
        mask = nodes["/VictoryPanel/All_Empty/Mask_Img" if state == "won" else "/FailPanel/Mask_Img"]
        layers = []
        replay = ("/VictoryPanel/All_Empty/Btn_Group" if state == "won"
                  else "/FailPanel/SafeArea/All_Anim/Revive_Empty/Btn2_Empty/Restart_Btn")
        report[state] = {"prefab":panel["source"], "maskAlpha":mask["graphics"][0]["color"]["a"],
                "maskSizeDelta":mask["rect"]["m_SizeDelta"],
                "replayPosition":centered_coordinates(replay,nodes), "layers":layers}
        if state == "lost":
            title = "/FailPanel/SafeArea/All_Anim/Revive_Empty/Title_Text"
            report[state]["titlePosition"] = centered_coordinates(title, nodes)
        for name, path in assets:
            node = nodes[path]
            graphic = next(graphic for graphic in node["graphics"] if graphic.get("sprite"))
            if not node["active"] or graphic["enabled"] != 1 or graphic["mode"] not in (0, 1):
                raise ValueError(f"Unexpected sprite state at {path}")
            sprite = readers[graphic["sprite"]["id"]].parse_as_object()
            source_size = tuple(round(value) for value in graphic["spriteRect"][2:])
            image, padding = restore_sprite_rect(sprite, source_size)
            output = destination / f"{name}.png"
            image.save(output)
            layers.append({"texture":name,"sourcePath":path,"sourceId":graphic["sprite"]["id"],
                    "spriteName":sprite.m_Name,"position":centered_coordinates(path,nodes),
                    "size":node["rect"]["m_SizeDelta"],"slice":graphic["border"] if graphic["mode"]==1 else None,
                    "cropTopLeft":padding,
                    "sha256":hashlib.sha256(output.read_bytes()).hexdigest()})
    (destination/"result-panel-layout.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")


if __name__ == "__main__":
    destination = pathlib.Path(sys.argv[3])
    destination.mkdir(parents=True,exist_ok=True)
    export(sys.argv[1],json.loads(pathlib.Path(sys.argv[2]).read_text()),destination)
