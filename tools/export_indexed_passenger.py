import json
import pathlib
import struct
import sys

from UnityPy.helpers.MeshHelper import MeshHandler
from inspect_art import load_environment, object_id

SOURCE_ID = "CAB-ebb0256ee0ababa83a981d5e92e4a33a:-6885171532804164987"
VAT_WIDTH = 471


def main():
    env = load_environment(sys.argv[1])
    source = next(reader for reader in env.objects if object_id(reader) == SOURCE_ID)
    handler = MeshHandler(source.parse_as_object())
    handler.process()
    triangles = handler.get_triangles()
    positions = [(x, y, -z) for x, y, z in handler.m_Vertices]
    normals = [(x, y, -z) for x, y, z in handler.m_Normals]
    uv = [(u, 1 - v) for u, v in handler.m_UV0]
    count = len(positions)
    if count != VAT_WIDTH or len(normals) != count or len(uv) != count or len(triangles) != 1:
        raise ValueError("Unexpected original mesh layout")
    sample_uv = [((index + 0.5) / count, 0.5) for index in range(count)]
    indices = [index for a, b, c in triangles[0] for index in (a, c, b)]
    assert max(indices) < count

    binary = bytearray()
    views = []
    accessors = []

    def accessor(payload, count, kind, component, target, **bounds):
        binary.extend(bytes((-len(binary)) % 4))
        offset = len(binary)
        binary.extend(payload)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload), "target": target})
        accessors.append({"bufferView": len(views) - 1, "count": count, "type": kind, "componentType": component, **bounds})
        return len(accessors) - 1

    def floats(data, kind, **bounds):
        return accessor(b"".join(struct.pack("<" + "f" * len(value), *value) for value in data),
                        len(data), kind, 5126, 34962, **bounds)

    attributes = {
        "POSITION": floats(positions, "VEC3", min=[min(row[a] for row in positions) for a in range(3)],
                           max=[max(row[a] for row in positions) for a in range(3)]),
        "NORMAL": floats(normals, "VEC3"),
        "TEXCOORD_0": floats(uv, "VEC2"),
        "TEXCOORD_1": floats(sample_uv, "VEC2"),
    }
    indices_accessor = accessor(struct.pack(f"<{len(indices)}H", *indices), len(indices), "SCALAR", 5123, 34963)
    gltf = {
        "asset": {"version": "2.0", "generator": "Unity AssetBundle mesh migration",
                  "extras": {"unityObject": SOURCE_ID, "vatLookup": "TEXCOORD_1.x"}},
        "nodes": [{"name": "Idle_boy01", "mesh": 0}],
        "scenes": [{"nodes": [0]}], "scene": 0,
        "meshes": [{"name": "Idle_boy01", "primitives": [{"attributes": attributes, "indices": indices_accessor}]}],
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(binary)}],
    }
    document = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    document += b" " * ((-len(document)) % 4)
    binary.extend(bytes((-len(binary)) % 4))
    file_size = 12 + 8 + len(document) + 8 + len(binary)
    output = pathlib.Path(sys.argv[2])
    output.write_bytes(struct.pack("<4sII", b"glTF", 2, file_size) +
                       struct.pack("<I4s", len(document), b"JSON") + document +
                       struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    print(json.dumps({"original_mesh": SOURCE_ID, "position_count": count, "vat_index_count": count,
                      "triangle_count": len(indices) // 3, "bytes": file_size, "asset": str(output)}))


if __name__ == "__main__":
    main()
