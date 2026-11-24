import collections
import json
import pathlib
import sys
import zipfile

import UnityPy

BUNDLES = {
    "bus_and_passenger", "game_prefabs", "game_ui", "game_scene_dependence",
    "uispriteatlas", "level_escape_a", "game_config", "common",
}
ASSETS = [
    "level1.asset", "GameScene.prefab", "bus_normal_4.prefab", "bus_normal_6.prefab",
    "passenger_blue.prefab", "passenger_orange.prefab", "GamePanel.prefab",
    "Btn_Replay.prefab", "VictoryPanel.prefab", "FailPanel.prefab",
]


def load_environment(apk):
    env = UnityPy.Environment()
    with zipfile.ZipFile(apk) as archive:
        manifest = json.loads(archive.read("assets/Sandbox/BundlesManifest_1.bytes"))
        catalog = manifest["Bundles"]
        pending = [i for i, entry in enumerate(catalog) if entry["BundleName"] in BUNDLES]
        selected = set()
        while pending:
            i = pending.pop()
            if i not in selected:
                selected.add(i)
                pending.extend(catalog[i]["DependIDs"])
        filenames = {
            pathlib.PurePosixPath(path).stem.rsplit("_", 1)[0]: path
            for path in archive.namelist()
            if path.startswith("assets/Sandbox/") and path.endswith(".bundle")
        }
        for index in sorted(selected):
            name = catalog[index]["BundleName"]
            member = filenames[name]
            payload = archive.read(member)
            offset = payload.find(b"UnityFS\0", 0, 96)
            if offset < 0:
                print(f"SKIPPED {name}: {payload[:32].hex()}", file=sys.stderr)
                continue
            env.load_file(payload[offset:], name=member)
    return env


def component_pointer(pair):
    return pair.component if hasattr(pair, "component") else pair[1]


def object_id(reader):
    return f"{reader.assets_file.name}:{reader.path_id}"


def describe_pointer(pointer):
    if pointer is None or pointer.m_PathID == 0:
        return None
    try:
        reader = pointer.deref()
        asset = reader.parse_as_object()
        return {
            "id": object_id(reader), "type": reader.type.name,
            "name": getattr(asset, "m_Name", getattr(asset, "m_ClassName", None)),
        }
    except Exception as error:
        return {"file_id": pointer.m_FileID, "path_id": pointer.m_PathID, "error": str(error)[:130]}


def vector(value, fields):
    return [getattr(value, field) for field in fields]


def inspect_game_object(reader, report, path="", depth=0):
    obj = reader.parse_as_object()
    path = f"{path}/{obj.m_Name}"
    transform = None
    for pair in obj.m_Component:
        obj_reader = component_pointer(pair).deref()
        kind = obj_reader.type.name
        report["components"][kind] += 1
        if kind in ("Transform", "RectTransform"):
            transform = obj_reader.parse_as_object()
        if kind in ("MeshFilter", "MeshRenderer", "SkinnedMeshRenderer", "Camera", "Light", "Animator", "MonoBehaviour"):
            asset = obj_reader.parse_as_object()
            entry = {"path": path, "type": kind}
            if hasattr(asset, "m_Mesh"):
                entry["mesh"] = describe_pointer(asset.m_Mesh)
            if hasattr(asset, "m_Materials"):
                entry["materials"] = [describe_pointer(ref) for ref in asset.m_Materials]
            if kind == "Animator":
                entry["controller"] = describe_pointer(asset.m_Controller)
                entry["avatar"] = describe_pointer(asset.m_Avatar)
            if kind == "MonoBehaviour":
                entry["script"] = describe_pointer(asset.m_Script)
                if depth < 3:
                    try:
                        tree = obj_reader.read_typetree()
                        entry["serialized_keys"] = sorted(tree)
                        entry["sprite"] = tree.get("m_Sprite")
                    except Exception as error:
                        entry["tree_error"] = str(error)[:160]
            if kind == "Camera":
                entry["camera"] = {
                    key: getattr(asset, key, None)
                    for key in ("orthographic", "orthographic_size", "field_of_view", "near_clip_plane", "far_clip_plane")
                }
            report["references"].append(entry)
    if transform:
        if depth < 3 or any(item["path"] == path and item.get("mesh") for item in report["references"][-12:]):
            report["transforms"][path] = {
                "active": obj.m_IsActive,
                "position": vector(transform.m_LocalPosition, "xyz"),
                "rotation": vector(transform.m_LocalRotation, "xyzw"),
                "scale": vector(transform.m_LocalScale, "xyz"),
            }
        for child in transform.m_Children:
            target = child.deref().parse_as_object().m_GameObject.deref()
            inspect_game_object(target, report, path, depth + 1)


def main():
    env = load_environment(sys.argv[1])
    report = {}
    for name in ASSETS:
        match = next(((path, reader) for path, reader in env.container.items()
                      if path.lower().endswith("/" + name.lower())), None)
        if match is None:
            report[name] = {"error": "not found in Bundle container"}
            continue
        path, reader = match
        if hasattr(reader, "deref"):
            reader = reader.deref()

        item = {"source": path, "id": object_id(reader), "type": reader.type.name}
        report[name] = item
        try:
            if reader.type.name == "GameObject":
                item.update(components=collections.Counter(), references=[], transforms={})
                inspect_game_object(reader, item)
            else:
                try:
                    tree = reader.read_typetree()
                    item["level_tree"] = tree
                except Exception as error:
                    item["tree_error"] = str(error)
                    item["script"] = describe_pointer(reader.parse_as_object().m_Script)
        except Exception as error:
            item["error"] = f"{type(error).__name__}: {error}"
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
