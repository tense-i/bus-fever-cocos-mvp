import hashlib
import json
import pathlib
import sys
from PIL import Image, ImageChops


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def alpha_mask(atlas, source, picked, text, size, softness, dilate, shift):
    face = source["fontData"]["m_FaceInfo"]
    config = source["config"]
    material = picked["material"]["floats"]
    scale = config["m_fontSize"] / face["m_PointSize"] * face["m_Scale"]
    slope = material["_GradientScale"] * scale
    padding = round(source["fontData"]["m_AtlasPadding"])
    glyphs = {entry["m_Index"]:entry for entry in picked["glyphs"]}
    chars = {entry["m_Unicode"]:entry for entry in picked["characters"]}
    sequence = [glyphs[chars[ord(letter)]["m_GlyphIndex"]] for letter in text]
    width = sum(glyph["m_Metrics"]["m_HorizontalAdvance"] * scale for glyph in sequence)
    if width > size[0]:
        raise ValueError("The authored font size does not fit the source rectangle")
    x = (size[0] - width) / 2
    baseline = size[1] / 2 + (face["m_AscentLine"] + face["m_DescentLine"]) * scale / 2
    result = Image.new("L", size)
    lut = [round(255 * max(0, min(1, 0.5 + ((sample/255 - 0.5 + dilate)*slope) / softness)))
           for sample in range(256)]
    for glyph in sequence:
        rect = glyph["m_GlyphRect"]
        m = glyph["m_Metrics"]
        gx, gy, gw, gh = (rect[k] for k in ("m_X","m_Y","m_Width","m_Height"))
        if gw and gh:
            top = atlas.height - gy - gh
            crop = atlas.crop((gx-padding, top-padding, gx+gw+padding, top+gh+padding))
            crop = crop.resize((max(1,round(crop.width*scale)),max(1,round(crop.height*scale))),Image.Resampling.BILINEAR)
            x0 = round(x + (m["m_HorizontalBearingX"]-padding) * scale + shift[0]*slope)
            y0 = round(baseline - (m["m_HorizontalBearingY"]+padding)*scale - shift[1]*slope)
            part = Image.new("L", size)
            part.paste(crop.point(lut), (x0,y0))
            result = ImageChops.lighter(result,part)
        x += m["m_HorizontalAdvance"]*scale
    return result


def main():
    source_dir, panel_layout, output = (pathlib.Path(arg) for arg in sys.argv[1:])
    source_path = source_dir/"hud-source.json"
    inventory = read(source_path)
    source = inventory["levelText"]
    picked = read(source_dir/"level-glyph-source.json")
    kerning = read(source_dir/"level-kerning.json")
    if kerning["pairs"] or picked["properties"]["m_HorizontalAlignment"] != 2 or picked["properties"]["m_VerticalAlignment"] != 512:
        raise ValueError("Unexpected source layout or kerning for Level 1")
    layout = read(panel_layout)["gamepanel.prefab"]["nodes"]
    nodes = {node["path"]:node["rect"] for node in layout}
    level = nodes[source["path"]]
    replay = nodes["/GamePanel/All_Empty/Top_Empty/Btn_Replay"]
    icon = nodes["/GamePanel/All_Empty/Top_Empty/Btn_Replay/Replay_Img"]
    title = source["config"]["m_text"].format(1)
    size = tuple(map(round,level["m_SizeDelta"]))
    atlas = Image.open(source_dir/"level-font-atlas.png").getchannel("A")
    floats = picked["material"]["floats"]
    shadow = alpha_mask(atlas,source,picked,title,size,1+floats["_UnderlaySoftness"],
                     floats["_UnderlayDilate"]*0.5,[floats["_UnderlayOffsetX"],floats["_UnderlayOffsetY"]])
    face = alpha_mask(atlas,source,picked,title,size,1,floats["_FaceDilate"]*0.5,[0,0])
    rgba = Image.new("RGBA",size,tuple(round(255*x) for x in picked["material"]["colors"]["_UnderlayColor"]))
    rgba.putalpha(shadow)
    fill = Image.new("RGBA",size,tuple(round(255*source["config"]["m_fontColor"][k]) for k in "rgba"))
    fill.putalpha(face)
    rgba = Image.alpha_composite(rgba,fill)
    if rgba.getbbox() is None:
        raise ValueError("The glyph atlas produced an empty label")

    output.mkdir(parents=True,exist_ok=True)
    image = output/"level-title.png"
    rgba.save(image)
    arrow = next(item for item in inventory["arrows"] if item["active"] and item["path"].endswith("/Arrow_01"))
    hud = {
        "level":{"anchor":level["m_AnchorMin"],"position":level["m_AnchoredPosition"],"size":level["m_SizeDelta"]},
        "replay":{"anchor":replay["m_AnchorMin"],"position":replay["m_AnchoredPosition"],"size":icon["m_SizeDelta"]},
        "arrow":{key:arrow[key] for key in ["position","rotation","scale"]},
        "provenance":{"label":title,"font":source["fontId"],"atlas":source["atlasId"],
                      "fontSize":source["config"]["m_fontSize"],"glyphBounds":rgba.getbbox(),
                      "titleSha256":hashlib.sha256(image.read_bytes()).hexdigest(),"arrowPath":arrow["path"]},
    }
    (output/"game-hud-layout.json").write_text(json.dumps(hud,indent=2)+"\n")


if __name__=="__main__":
    main()
