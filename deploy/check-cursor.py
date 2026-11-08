"""Check that a cursor file loads with libXcursor (the same format wlroots reads).

  python3 check-cursor.py ~/.icons/default/cursors/default
"""
import ctypes
import ctypes.util
import os
import sys


class XcursorImage(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint), ("size", ctypes.c_uint), ("width", ctypes.c_uint),
                ("height", ctypes.c_uint), ("xhot", ctypes.c_uint), ("yhot", ctypes.c_uint),
                ("delay", ctypes.c_uint), ("pixels", ctypes.c_void_p)]


lib_name = ctypes.util.find_library("Xcursor") or "libXcursor.so.1"
lib = ctypes.CDLL(lib_name)
lib.XcursorFilenameLoadImage.restype = ctypes.POINTER(XcursorImage)
lib.XcursorFilenameLoadImage.argtypes = [ctypes.c_char_p, ctypes.c_int]
for path in sys.argv[1:]:
    img = lib.XcursorFilenameLoadImage(os.path.expanduser(path).encode(), 24)
    if img:
        i = img.contents
        print(f"OK   {path}: {i.width}x{i.height} size {i.size}")
    else:
        print(f"FAIL {path}")
