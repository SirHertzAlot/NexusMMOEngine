#!/usr/bin/env python3
"""Render fortify frames.json to per-profile PNGs and animated GIFs.

Usage: render_frames.py <frames_dir> <out_dir>
Each profile gets: <profile>-stepNN.png per frame and <profile>.gif.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CELL = 18
COLORS = {
    "~": (52, 101, 164),    # water
    ",": (138, 156, 110),   # marsh
    ".": (168, 150, 110),   # land
    "=": (196, 178, 138),   # road
    "#": (110, 110, 116),   # wall
    "G": (214, 166, 62),    # gate
    "B": (214, 120, 62),    # barbican
    "T": (88, 88, 96),      # square tower
    "O": (88, 88, 96),      # round tower
    "K": (150, 60, 60),     # core / keep
    "*": (40, 32, 24),      # lilia stake pits
    "W": (70, 140, 200),    # internal well
    "R": (222, 184, 92),    # granary
}
CAPTION_H = 22


def render_frame(frame):
    grid = frame["grid"]
    w, h = len(grid[0]), len(grid)
    img = Image.new("RGB", (w * CELL, h * CELL + CAPTION_H), (24, 24, 28))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            color = COLORS.get(ch, (200, 0, 200))
            d.rectangle([x * CELL, y * CELL, (x + 1) * CELL - 1, (y + 1) * CELL - 1], fill=color)
            if ch in "TG BOK".replace(" ", ""):
                d.text((x * CELL + 5, y * CELL + 4), ch, fill=(240, 240, 240))
            if ch == "O":
                d.ellipse([x * CELL + 3, y * CELL + 3, (x + 1) * CELL - 4, (y + 1) * CELL - 4], outline=(240, 240, 240))
    d.text((4, h * CELL + 5), frame["caption"], fill=(230, 230, 230))
    return img


def main():
    frames_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    profiles = json.loads((frames_dir / "frames.json").read_text())
    for profile, frames in profiles.items():
        imgs = []
        for i, frame in enumerate(frames):
            img = render_frame(frame)
            img.save(out_dir / f"{profile}-step{i:02d}.png")
            imgs.append(img)
        imgs[0].save(
            out_dir / f"{profile}.gif",
            save_all=True,
            append_images=imgs[1:] + [imgs[-1]] * 3,
            duration=900,
            loop=0,
        )
        print(f"{profile}: {len(imgs)} frames -> {profile}.gif")


if __name__ == "__main__":
    main()
