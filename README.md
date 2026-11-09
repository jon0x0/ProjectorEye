# Projector Eye

**[Try the phone UI in your browser](https://jon0x0.github.io/ProjectorEye/)**: a demo with
no Pi. Pick an eye, switch modes, and move over the preview to be tracked.

A monster eye projected into a window: a half circle (flat side down) or the
whole screen. It wakes when someone moves below, blinks, stares at them and
follows them. When they leave it holds its gaze, looks around, then falls
asleep, or stays awake and patrols. Dozens of eyes (dragons, Sauron, demons,
creatures) are drawn live, and everything is tuned from a phone.

```
 Cameras                        Sensor                          Hub (projector Pi)
 Pi Camera Module ──┐   ┌──────────────────────────┐ WebSocket ┌───────────────────────────────┐
 RTSP/RTSPS cameras ┴─▶ │ sensor/ one worker per   │ ─motion─▶ │ hub/ cameras fused in gaze     │
 (e.g. Wyze, any        │ camera: ffmpeg/picamera2,│ ◀─config─ │      space, behaviour, settings│
  number of them)       │ OpenCV motion detection  │           │ :8080/         phone control UI│
                        │ :8081 MJPEG previews     │           │ :8080/display  Chromium kiosk  │
                        └──────────────────────────┘           └───────────────────────────────┘
```

The sensor can run on its own camera Pi or on the projector Pi itself (a Pi 5
does both at a full 60 fps).

* **hub** (projector Pi): aiohttp server. Owns the behaviour, settings
  (`config/settings.json`), eye templates (`eyes/`) and animations (`media/`).
  Maps every camera into the eye's point of view and merges their detections.
* **display page**: canvas/WebGL renderer in Chromium kiosk mode. It draws the
  eye procedurally, so lids, iris, pupil and gaze are all live parameters. The
  phone preview runs the same renderer.
* **sensor**: one worker per camera (Pi camera module or RTSP/RTSPS network
  camera via ffmpeg). Background subtraction, blob merging, an aim point per
  moving object, normalised targets ~15 times a second. Detection settings,
  camera logins and ignore zones come from the hub, so you tune them from the
  phone.

## Behaviour

| Phase | What happens |
|---|---|
| asleep | Black. Motion lasting `wake_confirm_s` starts waking. |
| waking | Keyframed sequence: fade in, lid cracks, closes, opens wide. |
| awake / orienting | `wake_blinks` blinks while looking ahead. |
| awake / tracking | Gaze follows the calibrated motion point. Random blinks. |
| awake / holding | Motion lost: stares at the last spot for `hold_s`. |
| awake / searching | Glances around for `search_s`, lid getting drowsy. |
| sleeping | Keyframed droop, fights it once, closes, fades out. Motion can interrupt. |
| media | An animation file plays inside the window instead of the eye. |

Modes (Control tab):

* **Auto**: one eye, as above.
* **Random**: like Auto, with a different eye (from a chosen pool) after each
  sleep, or every few minutes.
* **Manual**: you drive it (gaze pad, lid, pupil, wake/sleep/blink).
* **Demo**: cycles saved positions.
* **Track test**: follows motion and never sleeps; for calibration.

Also on the Control tab:

* **Always awake**: the eye never falls asleep. With no one to follow it darts
  around and, with **Security scan** on, sweeps slowly from side to side now
  and then. In Random mode it briefly sleeps to change eye every N minutes.
* **Full screen / Semicircle window**: the projected shape.

The Eyes tab also sets the eye shown at start-up.

## Try it on a PC first

Windows, macOS, Linux or WSL with Python 3.9+:

```bash
pip install aiohttp opencv-python-headless numpy
```

```bash
python -m hub --port 8790
```

```bash
python -m sensor --source synthetic --hub ws://127.0.0.1:8790/ws --preview-port 8791
```

Open `http://127.0.0.1:8790/display` (the "projector") and
`http://<pc-ip>:8790/` on your phone. The synthetic camera walks a figure
across the scene every 40 s. `--source opencv:0` uses a webcam;
`--source opencv:clip.mp4` replays a recorded clip.

On Windows, port 8080 is often reserved by Hyper-V, hence 8790 above.

Tests: `python tests/test_hub.py`. After changing default settings or eyes, run
`python tools/build_demo_data.py` to refresh the demo's copy. `sh tests/pi_load.sh` on a projector Pi
measures the real frame rate per eye plus CPU and temperature.

## Install on the Pis

Raspberry Pi OS Bookworm. Give each Pi a fixed IP (DHCP reservation). Copy
this folder to each Pi as the `pi` user (`deploy/create-pi-user.sh` makes a
key-only `pi` user if needed).

Projector Pi (Pi 5 recommended; a Pi 4 needs a lower *Render resolution*):

```bash
sh deploy/install-kiosk-lite.sh
```

For Raspberry Pi OS Lite: installs the `eye-hub` service and a console
auto-login that starts sway (a Wayland kiosk that hides the mouse cursor)
running Chromium full screen on `/display`. On the desktop image use
`deploy/install-display.sh` instead. The Projector tab sets the HDMI output
mode (e.g. 1920x1080@60 for a 4K-capable projector).

Motion sensor, on a camera Pi or on the projector Pi itself:

```bash
sh deploy/install-sensor.sh ws://192.168.1.50:8080/ws
```

Use the projector Pi's IP (or `ws://localhost:8080/ws` on the projector Pi).
Phones often can't resolve `.local` names, and the UI builds the camera
preview URL from the IP the sensor connects from. Network cameras are added
on the phone's Camera tab; resolution, fps and flips for the Pi camera module
are in `sensor/sensor_config.json`. The sensor runs at lower CPU priority
than the renderer.

Optional, on any Pi: `sh deploy/harden-pi.sh` keeps logs across reboots,
turns off Wi-Fi power saving and enables the hardware watchdog.

Logs: `journalctl -u eye-hub -f` and `journalctl -u eye-sensor -f`.
After copying new code to the projector Pi: `sh deploy/update-display.sh`.

## Setting up on site

1. **Projector tab**: turn on *Show alignment outline*. Move and size the half
   circle onto the window, then use the keystone corners if the projector
   isn't square-on. For rear projection onto window film, turn on *Mirror*.
   A little *Soft edge* hides small misalignment.
2. **Camera tab**: add cameras (*+ Add camera*; for a network camera enter its
   `rtsp://` or `rtsps://` URL, user and password; the password is stored on
   the hub only and never sent back to the browser). Check each live view and
   draw ignore zones over trees, the road, flags, timestamp overlays and
   anything else that moves. If a camera offers a low-resolution substream
   (Wyze: `stream1`, 640x360), use it: detection runs at 320 px anyway and it
   costs far less CPU. Raise *Sensitivity threshold* or
   *Minimum blob size* if it triggers on noise; *Merge nearby blobs* joins a
   person's arms/legs into one target. *Aim point in box* picks where on the
   box the eye looks: the default 0.35 is about chest/face height.
3. **Calibrate tab**: this sets the eyeline and the left/right span.
   * Someone stands in the detection area; a box shows on every camera that
     sees them.
   * Drag the gaze pad until the eye, seen from where they stand, looks right
     at them. Tap **Capture point**. The point records every camera that sees
     the person, which ties the cameras together as well as to the eye.
   * Repeat at 4–6 spots per camera covering left, centre, right, near and
     far. Each camera gets its own fit: affine (3+ points), perspective (4+,
     for a camera looking down at the ground at an angle), bilinear or
     quadratic. Tap a row to highlight that point on every view.
   * Press **Track test** and walk around to check.
   * Without points, the base mapping is used: *Mirror left/right* (on by
     default, because a camera facing the street sees a viewer's left on its
     right), gains, and *Eyeline* (vertical offset; positive looks down,
     which a 12–14 ft window needs).
   Mounting the camera close to the window keeps the mapping nearly linear.

   **Combine cameras** (same tab) draws every camera's live picture warped
   into the eye's view, with adjustable transparency. Until a camera has two
   calibration points, slide/scale/rotate sliders place it. Where both cameras
   see someone, the detections merge into one target and a chosen camera sets
   the position. An optional dividing line gives each side to one camera; the
   other camera covers that side only while the owner sees nobody there (a
   tree in its way, say).
4. **Behavior tab**: timings, blink rates, lid/pupil levels, eye movement,
   and the wake/sleep keyframes (editable JSON, *Test* plays them).

Gaze coordinates are as seen by the audience: x −1 (viewer's left) to +1,
y −1 (up) to +1 (down).

## Eyes

Templates are JSON files in `eyes/`. Every value is optional; missing ones
come from `DEFAULT_TEMPLATE` in `static/js/eye-schema.js`. The Eyes tab
switches between them, edits any parameter live on the projector, and saves
or saves-as-new.

To base an eye on a reference image, add artwork layers next to the JSON and
reference them in `images` (paths relative to `eyes/`):

```json
"images": {
  "iris": "dragon/iris.png",
  "sclera": "dragon/sclera.png",
  "lid": "dragon/lid.png",
  "overlay": "dragon/frame.png"
}
```

* `iris`: a square crop of the iris, transparent outside the circle. The
  pupil is still drawn on top, so it can dilate and stay a slit. Set
  `pupil.shape` to `none` if the art includes it.
* `sclera`: eyeball background, about 2.4:1.6.
* `lid`: lid skin texture, 2:1.1, covering the whole window.
* `overlay`: fixed 2:1 image drawn last (window frame, grime, cracks).

Anything not supplied stays procedural, so you can start with only an iris.

## Animations

Put MP4/WebM/GIF/PNG files in `media/` or upload them from the Media tab.
They play clipped to the window and keyed to the same alignment. Options:
play randomly while asleep (min/max interval), play instead of waking with a
given chance when motion appears, then wake the eye if someone's still there.
Each file can be disabled or weighted. Sound is off unless *Play sound* is on.
Use H.264 MP4 at 1080p or below for smooth playback on a Pi.

## Hardware notes

* **Night**: the Camera Module 2 sees little in the dark. Use the NoIR version
  with an 850 nm IR illuminator, or rely on porch/street light. The MOG2
  detector relearns automatically after large exposure jumps (see
  *Ignore changes larger than*).
* **Projector spill**: keep the camera's view off the window so the eye's own
  light doesn't register as motion, or cover that region with an ignore zone.
* If rendering is choppy, lower *Render resolution* on the Projector tab.
* The control UI has no login. Keep it on a private network.

## Layout

```
hub/        server.py (HTTP/WebSocket), brain.py (state machine), fusion.py (cameras -> gaze),
            calibration.py (camera->gaze fits), settings.py (defaults + persistence)
sensor/     eye_sensor.py (service, one worker per camera), motion.py (detector),
            sources.py (Pi camera, RTSP via ffmpeg, webcam/file, synthetic)
index.html  phone UI (at the root so GitHub Pages serves it as a demo)
static/     js/app.js (phone UI), js/demo-hub.js (in-browser hub for the demo),
            js/cameras.js (cameras, calibration views,
            combined view), display.html (kiosk), js/eye-renderer.js (shared renderer),
            js/shader-eye.js + js/dragon-eye.js (WebGL and photoreal eyes),
            js/eye-schema.js (template defaults/editor)
eyes/       eye templates            media/   animations
deploy/     systemd units, kiosk script, install scripts
tests/      behaviour and calibration tests
```

WebSocket messages (`/ws`): clients send `hello {role}`, `set {path, value}`
and `cmd {name, ...}`. The hub sends `init`, `settings`, `status`, `frame`
(20 Hz gaze/open/pupil targets), `phase` (with keyframes), `blink`, `eye` and
`media`. The sensor sends `motion {cam, targets:[{x,y,w,h,area}]}` and
`sensor_status {cam, status}`, and receives `config` (including its cameras).
