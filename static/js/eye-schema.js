// Eye template defaults and the editor schema.
//
// A template is JSON in eyes/<id>.json. Every value is optional; missing
// values come from DEFAULT_TEMPLATE. Optional `images` replace procedural
// layers with artwork (paths relative to /eyes/):
//   sclera  - eyeball background, drawn over x[-1.2,1.2] y[-1.2,0.4]
//   iris    - square image, drawn inside the iris circle (pupil drawn on top
//             unless pupil.shape is "none")
//   lid     - lid skin, 2:1.1 aspect, covers the whole window
//   overlay - fixed 2:1 image drawn over everything (frame, grime)

export const DEFAULT_TEMPLATE = {
  name: "Untitled eye",
  description: "",
  style: "classic",        // classic (2D eyeball) | fire | void | nebula (WebGL shader eyeballs)
  lids: "auto",            // auto (on, except fire) | on | off
  seed: 0,
  vignette: 0.65,
  blink_strength: 1,       // 1 full blinks, 0 never blinks (stares), between = twitch
  glitch: 0,               // digital glitch: scanlines + tearing bursts, 0..1
  // Static overlays across the window: cracked glass/porcelain, creeping frost.
  overlay_fx: { cracks: 0, crack_color: "#1a1410", frost: 0, frost_color: "#cfe8ff" },
  // Per-eye character, multiplying the Behavior tab's eye-movement settings.
  motion: {
    micro: 1,              // idle jitter (0 = unnaturally still)
    pursuit: 1,            // following lag (higher = sluggish)
    saccades: 1,           // quick jumps (0 = only slow drifting moves)
    drift: 0,              // slow wandering, even while fixed on a target
    pupil_snap: 0,         // 0..1 instant pupil contraction when it spots someone
    pupil_speed: 1,        // how fast the pupil adjusts
    blink_speed: 1,        // blink duration multiplier (higher = slower blinks)
    rollback: 0,           // 0..1 roll the eye up out of sight when it spots someone
    rollback_s: 1.2,       // how long the roll-back lasts
  },
  geometry: {
    eye_center_y: 0.45,
    iris_radius: 0.36,
    gaze_range_x: 0.55,
    gaze_range_y: 0.3,
    ball_radius: 0.95,
    lid_shape: 1.9,
    lid_open_height: 0.96,
    lower_lid: 0.06,
  },
  sclera: {
    center: "#f1e6c8",
    mid: "#d9c49a",
    edge: "#6b2a1c",
    veins: 22,
    vein_color: "#a0201a",
    vein_alpha: 0.7,
    vein_width: 0.008,
    vein_length: 0.55,
    blotches: 0,           // hemorrhage blotches
    blotch_color: "#9a0e08",
    facets: 0,             // compound-eye hex facet size; 0 = smooth
    facet_highlight: "#ffffff",
  },
  iris: {
    inner: "#f2e14a",
    mid: "#9cc22b",
    outer: "#2d5a12",
    limbus: "#0b1a05",
    limbus_width: 0.14,
    fibers: 160,
    fiber_color: "#1d3a0a",
    fiber_alpha: 0.45,
    spots: 14,
    glow: 0.3,
    glow_color: "#c8ff3a",
    chromatophores: 0,     // rippling light spots (cephalopod)
    chroma_color: "#5ff0d0",
    chroma_alpha: 0.6,
    chroma_speed: 1,
    cataract: 0,           // milky film over the lens, 0..1
    cataract_color: "#e8e4d0",
    glow_pulse: 0,         // Hz; throbbing glow (0 = steady)
    hypno: 0,              // hypnotic rings shrinking into the pupil, 0..1
    hypno_color: "#ff3040",
    hypno_speed: 1,
    glow_flicker: 0,       // candle-like flicker of the glow, 0..1
    spiral: 0,             // rotating spiral arms, 0..1
    spiral_arms: 3,
    spiral_speed: 0.8,
    spiral_color: "#ff40ff",
    gears: 0,              // number of turning gear rings
    gear_color: "#e0b050",
    gear_speed: 0.4,
    scanline: 0,           // sweeping sensor line, 0..1
    scan_color: "#ff2010",
    scan_speed: 1,
    cells: 0,              // reptile mottling: number of cells
    cell_size: 1,
    cell_color: "#3a1404",
    cell_fill: "#c8701a",
  },
  pupil: {
    shape: "slit",         // slit | round | goat | w | aperture | none
    blades: 6,             // aperture blades
    count: 1,              // >1: independent darting pupils
    spread: 0.55,          // how far they roam (iris radii)
    dart_s: 1,             // max time between darts
    clump_every: 8,        // seconds between clumping in the centre
    color: "#050505",
    min: 0.1,
    max: 0.55,
    height: 0.86,
    rim_color: "#ff9a00",
    rim_width: 0.012,
  },
  lid: {
    color: "#55613a",
    shade: "#1b2310",
    edge: "#120a05",
    edge_width: 0.03,
    wet_line: "#b56a5a",
    creases: 3,
    crease_color: "#1c240c",
    texture: 0.6,
    spots_color: "#2f3a18",
    lashes: 0,
    lash_length: 0.08,
    scales: 0,                 // scale size; 0 = smooth skin
    scale_highlight: "#c9a040",
    scale_style: "rows",       // rows (neat overlapping) | craggy (photographic, irregular, lit)
    light: 60,                 // craggy scales: light direction in degrees (0 right, 90 above)
    rim_highlight: "#c8c0b0",  // light catching the top of the lid rim
    rim_highlight_alpha: 0,
    fur: 0,                    // fur density 0..1
    fur_color: "#6a4a2a",
    feathers: 0,               // feather size; 0 = none
    feather_tip: "#d8c8a8",
  },
  highlight: { alpha: 0.75, size: 0.07, x: -0.35, y: -0.55,
    window: 0, window_color: "#b8dcff", window_size: 0.35, wx: 0.45, wy: -0.5 },   // window reflection
  images: { sclera: "", iris: "", lid: "", overlay: "" },
  // Used by style "fire". Geometry (eye height, iris size, gaze travel) and
  // pupil (min/max slit width, height) apply too; lids, sclera and iris don't.
  fire: {
    core: "#ffeba0",
    hot: "#ffb21e",
    mid: "#e8420a",
    dark: "#5c0600",
    background: "#3a0400",
    speed: 1.0,
    turbulence: 1.0,
    flame_reach: 0.6,
    fibers: 1.0,
    rim_glow: 1.0,
    slit_glow: 0.7,
    background_fire: 0.9,
    iris_aspect: 1.15,
    wisps: 0,              // flame strands feathering into the dark
    core_dark: 0,          // darker smouldering red near the pupil
    quality: 0.5,
    octaves: 5,
  },
  // style "dragon": photographic dragon eye in scaled skin (see dragon-eye.js).
  dragon: {
    x: 0.1, y: -0.44, rx: 0.33, ry: 0.2, tilt: -28,    // eye centre, half-length, half-height, rotation (deg)
    sharp: 1.25, sharp_back: 0.7, lower: 0.85,         // front/back corner sharpness (>1 pointed), lower lid ratio
    close_at: 0, squeeze: 0.15,                        // where the lids meet (0 centre), corners drawing in as it closes
    partial: 0.6,                                      // how far the lids open before the cover slides off
    scale_layout: "rows",                              // rows (follow the socket) | plates (irregular cells)
    light: 125,                                        // light direction (deg, 90 = from above)
    gaze_x: 0.35, gaze_y: 0.3,
    pupil_len: 0.82, pupil_tilt: 26,
    skin: "#4e2c20", skin_dark: "#20110b", skin_light: "#b07858", skin_red: "#7a2c1a", groove: "#0c0604",
    scale_min: 0.024, scale_max: 0.15,
    spikes: 5, spike_len: 0.3, spike_dir: 82, spike_from: [-0.92, -0.3], spike_to: [-0.42, -0.86],
    horn: "#5a3e2c", horn_light: "#c49c7a", horn_dark: "#140a06",
    rim: "#4a3428", rim_dark: "#1e130e", rim_light: "#9a7e6a", rim_wet: "#e0d0c0",
    lid_upper: 0.75, lid_lower: 0.55, rim_scale: 0.12,  // lid fold thickness (x eye height), lid scale tile size
    iris_inner: "#f0b860", iris_mid: "#c87428", iris_outer: "#7a320c", iris_rim: "#1a0602",
    iris_fiber_dark: "#4a1a06", iris_fiber_light: "#ffe0a0", iris_glow: "#fff0b0",
    glow_color: "#ff9a28", glow: 1,
    membrane: "#3e3836", membrane_light: "#6a6260", membrane_vein: "#2e2422",
    membrane_opacity: 0.97, membrane_angle: 215,       // direction it slides away (deg)
    reflections: [[-0.34, 0.2, 0.26], [-0.1, 0.48, 0.28]],
  },
  // style "sauron": geometry iris size/gaze, pupil min/max (oval width) and height.
  sauron: {
    core: "#fff3b0",
    hot: "#ffb224",
    mid: "#e5480a",
    dark: "#5a0600",
    halo_color: "#3a0400",
    flame_reach: 1.0,
    base: 0.95,                // flame base radius (minimum extent)
    aspect: 1.15,
    wisps: 1.0,
    halo: 0.6,
    inner_red: 0.7,
    feather: 1.0,
    speed: 1.0,
    quality: 0.5,
    octaves: 5,
  },
  // style "void": geometry eye height and iris size, pupil min/max (star size).
  void: {
    base: "#000000",
    smoke_color: "#1a1424",
    smoke: 0.8,
    sheen_color: "#cfd8e6",
    sheen: 0.5,
    iridescence: 0.7,
    star_color: "#f4f2ff",
    pulse: 0.6,
    parallax: 0.4,
    speed: 1,
    quality: 0.5,
    octaves: 5,
  },
  // style "nebula": iris size = galaxy, pupil min/max = black hole size.
  nebula: {
    deep: "#0d0630",
    dust_color: "#7a3cc8",
    core: "#ffd2f0",
    ring: "#ffb060",
    star_color: "#e8eaff",
    spin: 0.25,
    arms: 2,
    dust: 1,
    stars: 1,
    flares: 1,
    speed: 1,
    quality: 0.5,
    octaves: 5,
  },
};

export function mergeTemplate(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = mergeTemplate(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Editor schema: [section, [[key, type, min, max, step | options, label]]]
export const SCHEMA = [
  ["Overall", [
    ["name", "text", 0, 0, 0, "Name"],
    ["style", "select", 0, 0, ["classic", "dragon", "fire", "sauron", "void", "nebula"], "Style"],
    ["lids", "select", 0, 0, ["auto", "on", "off"], "Lids"],
    ["description", "text", 0, 0, 0, "Description"],
    ["seed", "number", 0, 9999, 1, "Random seed"],
    ["vignette", "range", 0, 1, 0.01, "Edge darkening"],
    ["blink_strength", "range", 0, 1, 0.01, "Blink strength (0 = unblinking)"],
    ["glitch", "range", 0, 1, 0.01, "Digital glitch"],
  ]],
  ["overlay_fx", [
    ["cracks", "range", 0, 2, 0.05, "Cracks"],
    ["crack_color", "color", 0, 0, 0, "Crack colour"],
    ["frost", "range", 0, 2, 0.05, "Frost"],
    ["frost_color", "color", 0, 0, 0, "Frost colour"],
  ]],
  ["motion", [
    ["micro", "range", 0, 4, 0.05, "Idle jitter (0 = dead still)"],
    ["pursuit", "range", 0.2, 10, 0.1, "Following lag (high = sluggish)"],
    ["saccades", "range", 0, 2, 0.05, "Quick jumps (0 = none)"],
    ["drift", "range", 0, 0.4, 0.005, "Wet drift"],
    ["pupil_snap", "range", 0, 1, 0.01, "Pupil snap on spotting"],
    ["pupil_speed", "range", 0.1, 5, 0.05, "Pupil reaction speed"],
    ["blink_speed", "range", 0.5, 4, 0.05, "Blink slowness"],
    ["rollback", "range", 0, 1, 0.01, "Roll back on spotting"],
    ["rollback_s", "range", 0.3, 4, 0.05, "Roll-back duration"],
  ]],
  ["geometry", [
    ["eye_center_y", "range", 0.1, 0.9, 0.01, "Eyeball height"],
    ["iris_radius", "range", 0.1, 0.7, 0.01, "Iris size"],
    ["gaze_range_x", "range", 0, 1, 0.01, "Gaze travel X"],
    ["gaze_range_y", "range", 0, 0.8, 0.01, "Gaze travel Y"],
    ["ball_radius", "range", 0.6, 3, 0.01, "Eyeball curvature"],
    ["lid_shape", "range", 1.2, 5, 0.05, "Lid roundness"],
    ["lid_open_height", "range", 0.6, 1.4, 0.01, "Lid open height"],
    ["lower_lid", "range", 0, 0.4, 0.01, "Lower lid"],
  ]],
  ["sclera", [
    ["center", "color", 0, 0, 0, "Centre"],
    ["mid", "color", 0, 0, 0, "Middle"],
    ["edge", "color", 0, 0, 0, "Edge"],
    ["veins", "range", 0, 80, 1, "Veins"],
    ["vein_color", "color", 0, 0, 0, "Vein colour"],
    ["vein_alpha", "range", 0, 1, 0.01, "Vein opacity"],
    ["vein_width", "range", 0.001, 0.03, 0.001, "Vein width"],
    ["vein_length", "range", 0.1, 1.2, 0.01, "Vein length"],
    ["blotches", "range", 0, 20, 1, "Hemorrhage blotches"],
    ["blotch_color", "color", 0, 0, 0, "Blotch colour"],
    ["facets", "range", 0, 0.12, 0.002, "Compound facets (0 = smooth)"],
    ["facet_highlight", "color", 0, 0, 0, "Facet highlight"],
  ]],
  ["iris", [
    ["inner", "color", 0, 0, 0, "Inner"],
    ["mid", "color", 0, 0, 0, "Middle"],
    ["outer", "color", 0, 0, 0, "Outer"],
    ["limbus", "color", 0, 0, 0, "Ring"],
    ["limbus_width", "range", 0, 0.5, 0.01, "Ring width"],
    ["fibers", "range", 0, 400, 1, "Fibres"],
    ["fiber_color", "color", 0, 0, 0, "Fibre colour"],
    ["fiber_alpha", "range", 0, 1, 0.01, "Fibre opacity"],
    ["spots", "range", 0, 60, 1, "Spots"],
    ["glow", "range", 0, 1, 0.01, "Glow"],
    ["glow_color", "color", 0, 0, 0, "Glow colour"],
    ["chromatophores", "range", 0, 200, 1, "Chromatophores"],
    ["chroma_color", "color", 0, 0, 0, "Chromatophore colour"],
    ["chroma_alpha", "range", 0, 1, 0.01, "Chromatophore strength"],
    ["chroma_speed", "range", 0, 4, 0.05, "Chromatophore pulse speed"],
    ["cataract", "range", 0, 1, 0.01, "Cataract film"],
    ["cataract_color", "color", 0, 0, 0, "Cataract colour"],
    ["glow_pulse", "range", 0, 3, 0.05, "Glow pulse (Hz)"],
    ["hypno", "range", 0, 1, 0.01, "Hypnotic rings"],
    ["hypno_color", "color", 0, 0, 0, "Ring colour"],
    ["hypno_speed", "range", 0, 4, 0.05, "Ring speed"],
    ["glow_flicker", "range", 0, 1, 0.01, "Glow flicker"],
    ["spiral", "range", 0, 1, 0.01, "Spiral"],
    ["spiral_arms", "range", 1, 8, 1, "Spiral arms"],
    ["spiral_speed", "range", -4, 4, 0.05, "Spiral speed"],
    ["spiral_color", "color", 0, 0, 0, "Spiral colour"],
    ["gears", "range", 0, 4, 1, "Gear rings"],
    ["gear_color", "color", 0, 0, 0, "Gear colour"],
    ["gear_speed", "range", -3, 3, 0.05, "Gear speed"],
    ["scanline", "range", 0, 1, 0.01, "Scan line"],
    ["scan_color", "color", 0, 0, 0, "Scan colour"],
    ["scan_speed", "range", 0, 4, 0.05, "Scan speed"],
    ["cells", "range", 0, 600, 5, "Mottled cells"],
    ["cell_size", "range", 0.3, 3, 0.05, "Cell size"],
    ["cell_color", "color", 0, 0, 0, "Cell outline"],
    ["cell_fill", "color", 0, 0, 0, "Cell fill"],
  ]],
  ["pupil", [
    ["shape", "select", 0, 0, ["slit", "round", "goat", "w", "aperture", "none"], "Shape"],
    ["blades", "range", 3, 12, 1, "Aperture blades"],
    ["count", "range", 1, 9, 1, "Number of pupils"],
    ["spread", "range", 0, 0.9, 0.01, "Pupil roaming area"],
    ["dart_s", "range", 0.1, 4, 0.05, "Time between darts"],
    ["clump_every", "range", 2, 40, 0.5, "Clump every (s)"],
    ["color", "color", 0, 0, 0, "Colour"],
    ["min", "range", 0.02, 0.8, 0.01, "Smallest"],
    ["max", "range", 0.05, 1, 0.01, "Largest"],
    ["height", "range", 0.2, 1, 0.01, "Slit length / bar width"],
    ["rim_color", "color", 0, 0, 0, "Rim colour"],
    ["rim_width", "range", 0, 0.08, 0.002, "Rim width"],
  ]],
  ["lid", [
    ["color", "color", 0, 0, 0, "Skin"],
    ["shade", "color", 0, 0, 0, "Skin shade"],
    ["edge", "color", 0, 0, 0, "Edge"],
    ["edge_width", "range", 0, 0.1, 0.002, "Edge width"],
    ["wet_line", "color", 0, 0, 0, "Wet line"],
    ["creases", "range", 0, 8, 1, "Creases"],
    ["crease_color", "color", 0, 0, 0, "Crease colour"],
    ["texture", "range", 0, 1, 0.01, "Texture"],
    ["spots_color", "color", 0, 0, 0, "Spot colour"],
    ["lashes", "range", 0, 60, 1, "Lashes"],
    ["lash_length", "range", 0, 0.3, 0.005, "Lash length"],
    ["scales", "range", 0, 0.2, 0.005, "Scale size (0 = skin)"],
    ["scale_highlight", "color", 0, 0, 0, "Scale highlight"],
    ["scale_style", "select", 0, 0, ["rows", "craggy"], "Scale style"],
    ["light", "range", 0, 180, 1, "Light direction (craggy)"],
    ["rim_highlight", "color", 0, 0, 0, "Rim highlight"],
    ["rim_highlight_alpha", "range", 0, 1, 0.01, "Rim highlight strength"],
    ["fur", "range", 0, 1, 0.01, "Fur"],
    ["fur_color", "color", 0, 0, 0, "Fur colour"],
    ["feathers", "range", 0, 0.3, 0.005, "Feather size (0 = none)"],
    ["feather_tip", "color", 0, 0, 0, "Feather tip colour"],
  ]],
  ["highlight", [
    ["alpha", "range", 0, 1, 0.01, "Strength"],
    ["size", "range", 0, 0.3, 0.005, "Size"],
    ["x", "range", -1, 1, 0.01, "X"],
    ["y", "range", -1, 1, 0.01, "Y"],
    ["window", "range", 0, 1, 0.01, "Window reflection"],
    ["window_color", "color", 0, 0, 0, "Reflection colour"],
    ["window_size", "range", 0.05, 1, 0.01, "Reflection size"],
    ["wx", "range", -1, 1, 0.01, "Reflection X"],
    ["wy", "range", -1, 1, 0.01, "Reflection Y"],
  ]],
  ["fire", [
    ["core", "color", 0, 0, 0, "White-hot core"],
    ["hot", "color", 0, 0, 0, "Hot"],
    ["mid", "color", 0, 0, 0, "Flame"],
    ["dark", "color", 0, 0, 0, "Embers"],
    ["background", "color", 0, 0, 0, "Background"],
    ["speed", "range", 0, 3, 0.01, "Flicker speed"],
    ["turbulence", "range", 0, 3, 0.01, "Turbulence"],
    ["flame_reach", "range", 0, 1.5, 0.01, "Flame reach"],
    ["fibers", "range", 0.3, 3, 0.01, "Iris fibre detail"],
    ["rim_glow", "range", 0, 2, 0.01, "Iris rim glow"],
    ["slit_glow", "range", 0, 2, 0.01, "Slit glow"],
    ["background_fire", "range", 0, 2, 0.01, "Background fire"],
    ["iris_aspect", "range", 0.6, 1.6, 0.01, "Iris tall/wide"],
    ["wisps", "range", 0, 3, 0.01, "Flame wisps"],
    ["core_dark", "range", 0, 1, 0.01, "Dark core near pupil"],
    ["quality", "range", 0.1, 1, 0.05, "Render quality (Pi: 0.3-0.5)"],
    ["octaves", "range", 2, 7, 1, "Noise detail (cost)"],
  ]],
  ["dragon", [
    ["x", "range", -0.8, 0.8, 0.005, "Eye X"],
    ["y", "range", -0.9, -0.15, 0.005, "Eye Y"],
    ["rx", "range", 0.08, 0.7, 0.005, "Eye length"],
    ["ry", "range", 0.05, 0.5, 0.005, "Eye height"],
    ["tilt", "range", -90, 90, 1, "Eye tilt (deg)"],
    ["sharp", "range", 0.4, 2, 0.01, "Front corner sharpness (high = pointed)"],
    ["sharp_back", "range", 0.4, 2, 0.01, "Back corner sharpness"],
    ["lower", "range", 0.4, 1.2, 0.01, "Lower lid height"],
    ["close_at", "range", 0, 1, 0.01, "Where the lids meet (0 = centre)"],
    ["squeeze", "range", 0, 0.5, 0.01, "Corners draw in when closing"],
    ["partial", "range", 0.1, 0.9, 0.01, "Lids open before cover slides"],
    ["scale_layout", "select", 0, 0, ["rows", "plates"], "Scale layout"],
    ["light", "range", 0, 180, 1, "Light direction"],
    ["gaze_x", "range", 0, 1, 0.01, "Gaze travel X"],
    ["gaze_y", "range", 0, 1, 0.01, "Gaze travel Y"],
    ["pupil_len", "range", 0.2, 1.2, 0.01, "Pupil length"],
    ["pupil_tilt", "range", -60, 60, 1, "Pupil tilt"],
    ["skin", "color", 0, 0, 0, "Skin"],
    ["skin_dark", "color", 0, 0, 0, "Skin dark"],
    ["skin_light", "color", 0, 0, 0, "Skin light"],
    ["groove", "color", 0, 0, 0, "Grooves between scales"],
    ["skin_red", "color", 0, 0, 0, "Skin red patches"],
    ["scale_min", "range", 0.01, 0.1, 0.001, "Scale size near eye"],
    ["scale_max", "range", 0.02, 0.2, 0.001, "Scale size far"],
    ["spikes", "range", 0, 12, 1, "Horn spikes"],
    ["spike_len", "range", 0.05, 0.5, 0.005, "Spike length"],
    ["spike_dir", "range", 0, 180, 1, "Spike direction"],
    ["horn", "color", 0, 0, 0, "Horn"],
    ["horn_light", "color", 0, 0, 0, "Horn light"],
    ["horn_dark", "color", 0, 0, 0, "Horn dark"],
    ["rim", "color", 0, 0, 0, "Lid rim"],
    ["rim_dark", "color", 0, 0, 0, "Lid rim dark"],
    ["rim_light", "color", 0, 0, 0, "Lid rim light"],
    ["rim_wet", "color", 0, 0, 0, "Lid wet line"],
    ["lid_upper", "range", 0.1, 1.5, 0.01, "Upper lid fold"],
    ["lid_lower", "range", 0.1, 1.5, 0.01, "Lower lid fold"],
    ["rim_scale", "range", 0.05, 0.6, 0.005, "Lid scale size"],
    ["iris_inner", "color", 0, 0, 0, "Iris inner"],
    ["iris_mid", "color", 0, 0, 0, "Iris middle"],
    ["iris_outer", "color", 0, 0, 0, "Iris outer"],
    ["iris_rim", "color", 0, 0, 0, "Iris rim"],
    ["iris_fiber_dark", "color", 0, 0, 0, "Iris dark fibres"],
    ["iris_fiber_light", "color", 0, 0, 0, "Iris light fibres"],
    ["iris_glow", "color", 0, 0, 0, "Iris gold ring"],
    ["glow_color", "color", 0, 0, 0, "Awake glow"],
    ["glow", "range", 0, 2, 0.01, "Awake glow strength"],
    ["membrane", "color", 0, 0, 0, "Membrane"],
    ["membrane_light", "color", 0, 0, 0, "Membrane light"],
    ["membrane_vein", "color", 0, 0, 0, "Membrane veins"],
    ["membrane_opacity", "range", 0.3, 1, 0.01, "Membrane opacity"],
    ["membrane_angle", "range", 0, 360, 1, "Membrane slides toward (deg)"],
  ]],
  ["sauron", [
    ["core", "color", 0, 0, 0, "White-hot"],
    ["hot", "color", 0, 0, 0, "Yellow flame"],
    ["mid", "color", 0, 0, 0, "Orange flame"],
    ["dark", "color", 0, 0, 0, "Smoulder red"],
    ["halo_color", "color", 0, 0, 0, "Haze colour"],
    ["flame_reach", "range", 0, 2, 0.01, "Flame reach"],
    ["base", "range", 0.5, 1.8, 0.01, "Flame base radius"],
    ["aspect", "range", 0.6, 1.8, 0.01, "Wide/tall"],
    ["wisps", "range", 0, 3, 0.01, "Wisps"],
    ["halo", "range", 0, 2, 0.01, "Red haze"],
    ["inner_red", "range", 0, 1, 0.01, "Red near pupil"],
    ["feather", "range", 0.4, 2.5, 0.01, "Feather detail"],
    ["speed", "range", 0, 3, 0.01, "Flicker speed"],
    ["quality", "range", 0.1, 1, 0.05, "Render quality (Pi: 0.3-0.5)"],
    ["octaves", "range", 2, 7, 1, "Noise detail (cost)"],
  ]],
  ["void", [
    ["base", "color", 0, 0, 0, "Base"],
    ["smoke_color", "color", 0, 0, 0, "Smoke colour"],
    ["smoke", "range", 0, 3, 0.01, "Smoke"],
    ["sheen_color", "color", 0, 0, 0, "Sheen colour"],
    ["sheen", "range", 0, 2, 0.01, "Glossy sheen"],
    ["iridescence", "range", 0, 2, 0.01, "Oily iridescence"],
    ["star_color", "color", 0, 0, 0, "Dying star colour"],
    ["pulse", "range", 0, 4, 0.01, "Star pulse speed"],
    ["parallax", "range", 0, 1, 0.01, "Smoke depth (parallax)"],
    ["speed", "range", 0, 3, 0.01, "Animation speed"],
    ["quality", "range", 0.1, 1, 0.05, "Render quality (Pi: 0.3-0.5)"],
    ["octaves", "range", 2, 7, 1, "Noise detail (cost)"],
  ]],
  ["nebula", [
    ["deep", "color", 0, 0, 0, "Deep space"],
    ["dust_color", "color", 0, 0, 0, "Cosmic dust"],
    ["core", "color", 0, 0, 0, "Galaxy core"],
    ["ring", "color", 0, 0, 0, "Photon ring / flares"],
    ["star_color", "color", 0, 0, 0, "Stars"],
    ["spin", "range", -2, 2, 0.01, "Galaxy rotation"],
    ["arms", "range", 1, 6, 1, "Spiral arms"],
    ["dust", "range", 0, 3, 0.01, "Dust brightness"],
    ["stars", "range", 0, 4, 0.05, "Star density"],
    ["flares", "range", 0, 3, 0.05, "Flares"],
    ["speed", "range", 0, 3, 0.01, "Animation speed"],
    ["quality", "range", 0.1, 1, 0.05, "Render quality (Pi: 0.3-0.5)"],
    ["octaves", "range", 2, 7, 1, "Noise detail (cost)"],
  ]],
  ["images", [
    ["sclera", "text", 0, 0, 0, "Sclera image"],
    ["iris", "text", 0, 0, 0, "Iris image"],
    ["lid", "text", 0, 0, 0, "Lid image"],
    ["overlay", "text", 0, 0, 0, "Overlay image"],
  ]],
];
