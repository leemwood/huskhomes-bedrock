"""Build the independent HuskHomes Bedrock behavior pack; no third-party libraries."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import struct
import uuid
import zipfile
import zlib

STAMP = (2026, 1, 1, 0, 0, 0)


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for name, data in sorted(entries):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, data)
    return buffer.getvalue()


ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "packs" / "HuskHomes_BP"
OUTPUT = ROOT / "dist"


def icon():
    size = 128
    pixels = bytearray(bytes((20, 35, 46, 255)) * size * size)

    def rect(x1, y1, x2, y2, color):
        for y in range(y1, y2):
            for x in range(x1, x2):
                offset = (y * size + x) * 4
                pixels[offset:offset + 4] = bytes((*color, 255))

    rect(16, 108, 112, 116, (52, 112, 101))
    rect(30, 58, 98, 108, (228, 213, 177))
    for y in range(24, 66, 6):
        half = (y - 18) // 2
        rect(64 - half, y, 64 + half, y + 6, (217, 132, 77))
    rect(48, 78, 66, 108, (76, 68, 63))
    rect(76, 74, 88, 86, (108, 203, 206))
    rect(10, 26, 16, 44, (115, 221, 207))
    rect(4, 32, 22, 38, (115, 221, 207))
    rect(106, 12, 112, 30, (115, 221, 207))
    rect(100, 18, 118, 24, (115, 221, 207))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + pixels[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    manifest = json.loads((PACK / "manifest.json").read_text(encoding="utf-8"))
    identifiers = [manifest["header"]["uuid"], *(module["uuid"] for module in manifest["modules"])]
    assert len(set(identifiers)) == len(identifiers)
    for identifier in identifiers:
        uuid.UUID(identifier)
    assert manifest["format_version"] == 2
    assert manifest["header"]["min_engine_version"] == [1, 26, 70]
    assert manifest["dependencies"] == [
        {"module_name": "@minecraft/server", "version": "2.11.0"},
        {"module_name": "@minecraft/server-ui", "version": "2.3.0"},
    ]
    assert (PACK / "scripts" / "main.js").is_file()
    (PACK / "pack_icon.png").write_bytes(icon())
    entries = [(p.relative_to(PACK).as_posix(), p.read_bytes()) for p in PACK.rglob("*") if p.is_file()]
    entries.extend([("README.txt", (ROOT / "README.md").read_bytes()), ("LICENSE.txt", (ROOT / "LICENSE").read_bytes())])
    mcpack = archive(entries)
    version = ".".join(map(str, manifest["header"]["version"]))
    stem = f"HuskHomes-Bedrock-{version}"
    artifacts = {f"{stem}.mcpack": mcpack, f"{stem}.mcaddon": archive([(f"{stem}.mcpack", mcpack)])}
    OUTPUT.mkdir(exist_ok=True)
    sums = []
    for name, data in artifacts.items():
        (OUTPUT / name).write_bytes(data)
        with zipfile.ZipFile(io.BytesIO(data)) as output:
            assert output.testzip() is None
            if name.endswith(".mcpack"):
                assert output.read("manifest.json") == (PACK / "manifest.json").read_bytes()
                assert "scripts/main.js" in output.namelist()
            else:
                assert output.read(f"{stem}.mcpack") == mcpack
        sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
        print(f"Built {name} ({len(data):,} bytes)")
    (OUTPUT / "SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
