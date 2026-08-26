#!/usr/bin/env python3
"""Regenerate the placeholder toolbar icons as solid brand-color PNGs.

No image library required (Pillow isn't assumed to be installed) — this
writes minimal valid PNGs directly. Replace with real designed icons before
shipping to a store listing; solid squares are a functional placeholder for
local development and unpacked-extension loading only.
"""
import os
import struct
import zlib

BRAND_RGB = (0x5B, 0x63, 0xE3)  # @veynlo/design-tokens brand[500]
SIZES = (16, 48, 128)
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")


def write_png(path, size, rgb):
    r, g, b = rgb
    raw = b"".join(b"\x00" + bytes([r, g, b]) * size for _ in range(size))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        write_png(os.path.join(OUT_DIR, f"icon-{size}.png"), size, BRAND_RGB)
        print(f"wrote icon-{size}.png")


if __name__ == "__main__":
    main()
