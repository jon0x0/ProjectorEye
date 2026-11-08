"""Write an Xcursor theme whose cursors are a single transparent pixel.

cage (the kiosk compositor) has no option to hide its pointer and always
loads the theme named "default" (it ignores XCURSOR_THEME), so the kiosk
installs this as ~/.icons/default for the kiosk user. Usage:
  python3 make-invisible-cursor.py ~/.icons/default
"""
import os
import struct
import sys

# Every common cursor name, so nothing falls back to a visible theme.
NAMES = ["default", "left_ptr", "arrow", "top_left_arrow", "pointer", "hand1", "hand2", "text", "xterm",
         "watch", "wait", "progress", "left_ptr_watch", "crosshair", "cross", "move", "grab", "grabbing",
         "not-allowed", "help", "question_arrow", "context-menu", "cell", "copy", "alias", "all-scroll",
         "col-resize", "row-resize", "n-resize", "s-resize", "e-resize", "w-resize", "ne-resize", "nw-resize",
         "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in",
         "zoom-out", "vertical-text", "no-drop", "dnd-none", "sb_h_double_arrow", "sb_v_double_arrow"]


def xcursor_1px(test=False):
    """Transparent 1x1 cursor; test=True makes a visible 16x16 red square instead."""
    if test:
        size = 16
        image = struct.pack("<9I", 36, 0xFFFD0002, size, 1, size, size, 0, 0, 0) + struct.pack("<I", 0xFFFF0000) * (size * size)
        header = struct.pack("<4sIII", b"Xcur", 16, 0x10000, 1)
        return header + struct.pack("<III", 0xFFFD0002, size, 16 + 12) + image
    size = 1
    image = struct.pack("<9I", 36, 0xFFFD0002, size, 1, 1, 1, 0, 0, 0) + struct.pack("<I", 0)
    header = struct.pack("<4sIII", b"Xcur", 16, 0x10000, 1)
    toc = struct.pack("<III", 0xFFFD0002, size, 16 + 12)
    return header + toc + image


def main(theme_dir, test=False):
    cursors = os.path.join(theme_dir, "cursors")
    os.makedirs(cursors, exist_ok=True)
    data = xcursor_1px(test)
    for name in NAMES:
        with open(os.path.join(cursors, name), "wb") as f:
            f.write(data)
    with open(os.path.join(theme_dir, "index.theme"), "w") as f:
        f.write("[Icon Theme]\nName=invisible\nComment=Transparent cursors for the eye kiosk\n")
    print("invisible cursor theme in", theme_dir)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--test-red"]
    main(os.path.expanduser(args[0] if args else "~/.icons/invisible"), test="--test-red" in sys.argv)
