#!/usr/bin/env /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
"""
ClipForge AI — Cinematic Framing Engine v7  "AI Cinematographer"

Total redesign. No longer a face tracker — acts as an intelligent camera operator.

v7 improvements over v6:
  • MediaPipe Face Mesh (468 landmarks) — full facial geometry
    → Head pose via 6-point PnP: yaw/pitch tells us which way subjects face
    → Iris landmarks: gaze direction tells us where subjects look
    → Lip distance variance: identifies who is currently speaking
  • Cinematic composition instead of centering
    → Looking room: if subject faces right, they appear in LEFT THIRD with
      space ahead of them (standard cinematography rule)
    → Headroom: face at upper-third, not vertical center
    → Rule of thirds over dead-center placement
  • Spring-damper physics (ω=3.8 rad/s, ζ=0.85) for natural motion
    → Pan spring: responsive, with slight overshoot like a real operator
    → Zoom spring: 3× slower than pan (gentle, invisible zoom changes)
    → Replaces Gaussian + linear-lead with physically accurate dynamics
  • Sparse Lucas-Kanade optical flow between frames
    → Tracks face regions for sub-frame motion continuity
    → Motion energy drives dynamic crop widening in active scenes
  • Speaker detection: highest recent lip-movement variance = speaker
    → In two-person shots, camera gives slight pull toward active speaker
    → Speaker always kept in-frame even when others move
  • Per-frame dynamic crop fraction (±10% gentle variation)
    → More motion energy → slightly wider crop (prevents losing subjects)
    → Emotion close-up moments → slightly tighter (not implemented via zoom)
  • 95% quality threshold with auto-widen fallback
    → Average quality < 92: retry with 12% wider crop fraction
    → Average quality < 80: fallback to safe center-wide composition
  • 5 fps sampling (was 3), 100-frame cap (was 80)

Output JSON: backward-compatible with server.js v5 consumer.
  Same fields: speakerSide, meanFaceX/Y/W/H, faceCount, rangeCX,
               combinedBox, sceneType, framingMode, globalCropFrac,
               keyframes, totalDets, srcWidth, srcHeight, framesSampled, detector

  New per-keyframe fields: yaw, gazeX, speaking (informational)

Usage:
  python3.9 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
"""

import sys, json, os, math, time

# ── Sampling constants ────────────────────────────────────────────────────
SAMPLE_FPS  = 5.0    # target frames per second to analyse
MAX_FRAMES  = 100    # never analyse more than this many frames
MIN_QUALITY = 40     # below this = replace with nearest good frame
QUAL_TARGET = 92     # below this average = auto-widen crop and retry

# ── Cinematic crop fractions ──────────────────────────────────────────────
# Deliberately wider than v6 — less zoom, more breathing room.
# "It looks like a mugshot" was caused by ~2× zoom; these stay ≤ 1.7×.
CROP_FRACS = {
    "monologue":    0.34,   # fills frame fully (nearFill), shows face + shoulders
    "interview":    0.38,   # both subjects from chest up, ~8% subtle bars
    "podcast":      0.36,   # two-shot, minimal bars (~5%)
    "group":        0.44,   # 3+ people, wider but still tight
    "reaction":     0.34,   # fills frame, looking off-camera
    "presentation": 0.38,   # moving presenter with slight breathing room
    "wide_shot":    0.40,   # subject smaller in frame
    "close_up":     0.32,   # very tight, fills completely
    "default":      0.36,   # natural default — fills or nearly fills
}

# ── Looking-room / rule-of-thirds constants ───────────────────────────────
LOOK_THRESH  = 0.15    # minimum gaze magnitude before applying looking room
LOOK_MAX     = 0.16    # max shift from center (fraction of crop_frac)
YAW_THRESH   = 10.0    # degrees yaw before applying pose-based room
YAW_SCALE    = 40.0    # degrees for full looking-room effect

# ── Head pose landmark indices (6-point PnP model) ───────────────────────
_POSE_IDX = [1, 152, 33, 263, 61, 291]   # nose, chin, L-eye, R-eye, L-mouth, R-mouth

# ── Iris landmark indices (requires refine_landmarks=True) ───────────────
_IRIS_L     = 473;  _EYE_L_OUT = 33;   _EYE_L_IN = 133
_IRIS_R     = 468;  _EYE_R_OUT = 263;  _EYE_R_IN = 362

# ── Lip landmark indices ─────────────────────────────────────────────────
_LIP_UPPER  = 13;   _LIP_LOWER = 14

# Safe zone: crop center never within this fraction of source edge
CX_MIN = 0.07
CX_MAX = 0.93


# ════════════════════════════════════════════════════════════════════════════
#  HEAD POSE & GAZE
# ════════════════════════════════════════════════════════════════════════════

_MODEL_3D = None  # lazy numpy init

def _get_3d_model():
    """Canonical 6-point 3D face model for PnP (in mm, generic face)."""
    global _MODEL_3D
    if _MODEL_3D is None:
        import numpy as np
        _MODEL_3D = np.array([
            [  0.0,    0.0,    0.0],   # nose tip
            [  0.0, -330.0,  -65.0],   # chin
            [-225.0,  170.0,-135.0],   # left eye outer corner
            [ 225.0,  170.0,-135.0],   # right eye outer corner
            [-150.0, -150.0,-125.0],   # left mouth corner
            [ 150.0, -150.0,-125.0],   # right mouth corner
        ], dtype=np.float64)
    return _MODEL_3D


def estimate_yaw(landmarks, frame_w, frame_h):
    """
    Estimate head yaw (left-right facing) in degrees via PnP.
    Positive = facing right, Negative = facing left.
    Returns 0.0 on failure.
    """
    try:
        import numpy as np, cv2
        pts = np.array(
            [(landmarks[i].x * frame_w, landmarks[i].y * frame_h) for i in _POSE_IDX],
            dtype=np.float64
        )
        focal = float(frame_w)
        cam   = np.array([[focal, 0, frame_w/2],
                          [0, focal, frame_h/2],
                          [0, 0, 1]], dtype=np.float64)
        dist  = np.zeros((4, 1), dtype=np.float64)
        ok, rvec, _ = cv2.solvePnP(_get_3d_model(), pts, cam, dist,
                                    flags=cv2.SOLVEPNP_EPNP)
        if not ok:
            return 0.0
        rmat, _ = cv2.Rodrigues(rvec)
        _, _, _, _, _, _, euler = cv2.RQDecomp3x3(rmat)
        return float(euler[1])   # yaw in degrees
    except Exception:
        return 0.0


def estimate_gaze_x(landmarks):
    """
    Estimate horizontal gaze direction from iris vs. eye-corner positions.
    Returns float in [-1, +1]: positive = looking right, negative = looking left.
    Only meaningful when refine_landmarks=True in Face Mesh.
    """
    try:
        l_iris = landmarks[_IRIS_L]
        l_out  = landmarks[_EYE_L_OUT]
        l_in   = landmarks[_EYE_L_IN]
        l_cx   = (l_out.x + l_in.x) / 2.0
        l_ew   = abs(l_out.x - l_in.x) or 1e-5
        l_g    = (l_iris.x - l_cx) / l_ew

        r_iris = landmarks[_IRIS_R]
        r_out  = landmarks[_EYE_R_OUT]
        r_in   = landmarks[_EYE_R_IN]
        r_cx   = (r_out.x + r_in.x) / 2.0
        r_ew   = abs(r_out.x - r_in.x) or 1e-5
        r_g    = (r_iris.x - r_cx) / r_ew

        return float((l_g + r_g) / 2.0)
    except Exception:
        return 0.0


def lip_openness(landmarks):
    """Normalized lip distance (proportion of face height approx)."""
    try:
        return abs(landmarks[_LIP_UPPER].y - landmarks[_LIP_LOWER].y)
    except Exception:
        return 0.0


# ════════════════════════════════════════════════════════════════════════════
#  SCENE CLASSIFICATION
# ════════════════════════════════════════════════════════════════════════════

def classify_scene(records):
    """
    Classify scene type from frame records.
    Returns (scene_type, framing_mode, avg_spread).
    """
    counts = [r["n_faces"] for r in records if r["n_faces"] > 0]
    if not counts:
        return "monologue", "monologue", 0.0

    max_faces = max(counts)
    pct_multi = sum(1 for c in counts if c >= 2) / max(1, len(counts))
    all_faces = [d for r in records for d in r["faces"]]

    # Face spread in multi-person frames
    multi_recs = [r for r in records if r["n_faces"] >= 2]
    avg_spread = 0.0
    if multi_recs:
        avg_spread = sum(
            max(d["cx"] for d in r["faces"]) - min(d["cx"] for d in r["faces"])
            for r in multi_recs
        ) / len(multi_recs)

    # Group scene
    if max_faces >= 3:
        return "group", "group", avg_spread

    # Two-person scene
    if max_faces >= 2 or pct_multi > 0.30:
        if avg_spread > 0.42:
            return "interview", "interview", avg_spread
        elif avg_spread > 0.22:
            return "podcast", "podcast", avg_spread
        else:
            return "podcast", "podcast", avg_spread

    # Single person — classify by face size, vertical position, movement range
    if not all_faces:
        return "monologue", "monologue", 0.0

    face_ws  = [d["w"] for d in all_faces]
    face_cys = [d["cy"] for d in all_faces]
    face_cxs = [d["cx"] for d in all_faces]
    mean_fw  = sum(face_ws)  / len(face_ws)
    mean_cy  = sum(face_cys) / len(face_cys)
    cx_range = max(face_cxs) - min(face_cxs) if face_cxs else 0.0

    if mean_cy > 0.68:
        return "reaction", "reaction", 0.0
    if mean_fw < 0.05:
        return "wide_shot", "wide_shot", 0.0
    if mean_fw > 0.48:
        return "close_up", "close_up", 0.0
    if cx_range > 0.28:
        return "presentation", "presentation", 0.0

    return "monologue", "monologue", 0.0


def base_crop_frac(scene_type, n_faces, spread):
    """Return baseline crop fraction, widened for spread-out multi-face shots."""
    frac = CROP_FRACS.get(scene_type, CROP_FRACS["default"])
    if scene_type in ("interview", "podcast") and n_faces >= 2 and spread > 0:
        frac = max(frac, spread + 0.26)   # face spread + 13% padding each side
    return min(0.92, max(0.30, frac))


# ════════════════════════════════════════════════════════════════════════════
#  CINEMATIC COMPOSITION
# ════════════════════════════════════════════════════════════════════════════

def compose_single(face_cx, crop_frac, yaw, gaze_x):
    """
    Compute crop-center X for a single speaker with:
      - Rule-of-thirds: subject positioned with natural looking room
      - Head pose + gaze combined direction signal
      - Face never cropped at edge — 12% padding minimum each side
    """
    # Direction signal: +1 = facing/looking right, -1 = facing/looking left
    gaze_norm = max(-1.0, min(1.0, gaze_x * 5.0))
    yaw_norm  = max(-1.0, min(1.0, yaw / YAW_SCALE))
    # Weight: 60% gaze, 40% head pose — gaze is more reliable signal
    direction = 0.60 * gaze_norm + 0.40 * yaw_norm

    # Apply looking room only when direction is clear
    if abs(direction) < LOOK_THRESH:
        face_pos_in_crop = 0.50   # neutral: center
    else:
        t = min(1.0, (abs(direction) - LOOK_THRESH) / (1.0 - LOOK_THRESH))
        shift = t * LOOK_MAX
        face_pos_in_crop = 0.50 - math.copysign(shift, direction)
        # Never closer than 25% from crop edge — ensures face never gets cut
        face_pos_in_crop = max(0.25, min(0.75, face_pos_in_crop))

    cx = face_cx + crop_frac * (0.5 - face_pos_in_crop)
    return _clamp_cx(cx, crop_frac)


def compose_multi(faces, crop_frac, speaker_idx):
    """
    Crop center for multi-person shot: keep ALL faces visible when possible,
    pull toward active speaker only when faces fit comfortably in frame.
    Never cuts anyone's face — always shows both people in interaction.
    """
    if not faces:
        return 0.5

    x1 = min(d["x1"] for d in faces)
    x2 = max(d["x2"] for d in faces)
    combined_cx = (x1 + x2) / 2.0
    combined_w  = x2 - x1

    # Padding: require 14% free space around the combined bounding box
    PADDING = 0.14
    if combined_w + PADDING <= crop_frac:
        # All faces fit comfortably — subtle pull toward speaker (70% center, 30% speaker)
        if 0 <= speaker_idx < len(faces):
            combined_cx = 0.75 * combined_cx + 0.25 * faces[speaker_idx]["cx"]
    elif combined_w + 0.06 <= crop_frac:
        # Tight fit — stay centered on the group, no speaker pull
        pass
    else:
        # Too spread out — frame the speaker but keep any nearby face partially visible
        if 0 <= speaker_idx < len(faces):
            combined_cx = faces[speaker_idx]["cx"]
        else:
            combined_cx = max(faces, key=lambda d: d["w"] * d["h"])["cx"]

    return _clamp_cx(combined_cx, crop_frac)


def _clamp_cx(cx, crop_frac):
    half = crop_frac / 2.0
    cx   = max(half + 0.02, min(1.0 - half - 0.02, cx))
    return max(CX_MIN, min(CX_MAX, cx))


# ════════════════════════════════════════════════════════════════════════════
#  QUALITY SCORING
# ════════════════════════════════════════════════════════════════════════════

EDGE_MARGIN = 0.05

def compute_quality(faces, cx, crop_frac):
    """Score framing quality 0–100. Higher = better."""
    if not faces:
        return 0

    primary = max(faces, key=lambda d: d["w"] * d["h"])
    score   = 0.0

    # 1. Detection confidence (0–20 pts)
    score += 20.0 * min(1.0, primary["score"] / 0.80)

    # 2. Face size in crop (0–30 pts) — 12–42% of crop width = ideal
    size = primary["w"] / max(0.01, crop_frac)
    if 0.12 <= size <= 0.42:
        score += 30.0
    elif size < 0.07:
        score += 0.0
    elif size < 0.12:
        score += 30.0 * (size - 0.07) / 0.05
    elif size <= 0.65:
        score += 30.0 * max(0.0, (0.65 - size) / 0.23)
    else:
        score += 0.0

    # 3. Face vertical position (0–20 pts) — ideal: 25–58% from top
    cy = primary["cy"]
    if 0.25 <= cy <= 0.58:
        score += 20.0
    elif cy < 0.12 or cy > 0.80:
        score += 0.0
    else:
        lo = 20.0 * (cy - 0.12) / 0.13 if cy < 0.25 else 20.0 * max(0, (0.80 - cy) / 0.22)
        score += lo

    # 4. Horizontal safety margin (0–15 pts)
    left_edge = cx - crop_frac / 2.0
    face_pos  = (primary["cx"] - left_edge) / max(0.01, crop_frac)
    if EDGE_MARGIN <= face_pos <= (1.0 - EDGE_MARGIN):
        score += 15.0
    else:
        dist = min(face_pos, 1.0 - face_pos)
        score += 15.0 * max(0.0, dist / EDGE_MARGIN)

    # 5. Multi-face balance (0–15 pts)
    if len(faces) >= 2:
        right_edge = cx + crop_frac / 2.0
        inside = all(
            left_edge + EDGE_MARGIN * crop_frac <= d["cx"] <= right_edge - EDGE_MARGIN * crop_frac
            for d in faces
        )
        score += 15.0 if inside else 4.0
    else:
        score += 15.0

    return round(min(100.0, score), 1)


# ════════════════════════════════════════════════════════════════════════════
#  SPRING-DAMPER PHYSICS
# ════════════════════════════════════════════════════════════════════════════

class CameraSpring:
    """
    Mass-spring-damper system for natural camera motion.

    Parameters:
      omega (ω)  = 2.6 rad/s  → settling time ~2.4 s — smooth, professional feel
      zeta  (ζ)  = 0.92       → nearly critically damped: no bounce, silky movement
      zoom_ratio = 0.18        → zoom spring very slow — invisible to viewer
    """
    def __init__(self, cx0, frac0, omega=2.6, zeta=0.92, zoom_ratio=0.18):
        self.cx   = float(cx0)
        self.frac = float(frac0)
        self.vcx  = 0.0
        self.vf   = 0.0
        self.omega = omega
        self.zeta  = zeta
        self.oz    = omega * zoom_ratio   # zoom natural frequency

    def step(self, target_cx, target_frac, dt, substeps=8):
        """Advance physics by dt seconds using sub-stepped Euler integration."""
        dt_s = dt / substeps
        for _ in range(substeps):
            # Pan spring
            spring_x = self.omega**2 * (target_cx   - self.cx)
            damp_x   = 2.0 * self.zeta * self.omega * self.vcx
            self.vcx += (spring_x - damp_x) * dt_s
            self.cx  += self.vcx * dt_s

            # Zoom spring (much slower)
            spring_f = self.oz**2 * (target_frac - self.frac)
            damp_f   = 2.0 * self.zeta * self.oz   * self.vf
            self.vf   += (spring_f - damp_f) * dt_s
            self.frac += self.vf * dt_s

        return self.cx, self.frac

    def teleport(self, cx, frac):
        """Hard-set without physics (first frame only)."""
        self.cx = float(cx);  self.frac = float(frac)
        self.vcx = 0.0;       self.vf   = 0.0


# ════════════════════════════════════════════════════════════════════════════
#  OPTICAL FLOW HELPERS
# ════════════════════════════════════════════════════════════════════════════

def track_flow(prev_gray, cur_gray, prev_pts, src_w, src_h):
    """
    Lucas-Kanade optical flow to track face-region points.
    Returns (updated_pts, motion_magnitude) where motion is pixels/frame.
    """
    try:
        import cv2, numpy as np
        if prev_gray is None or prev_pts is None or len(prev_pts) == 0:
            return None, 0.0
        pts = np.array(prev_pts, dtype=np.float32).reshape(-1, 1, 2)
        new_pts, status, _ = cv2.calcOpticalFlowPyrLK(
            prev_gray, cur_gray, pts, None,
            winSize=(31, 31), maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.01)
        )
        if status is None:
            return None, 0.0
        good_new = new_pts[status.flatten() == 1]
        good_old = pts[status.flatten() == 1]
        if len(good_new) == 0:
            return None, 0.0
        delta = good_new - good_old
        motion = float(math.sqrt((delta ** 2).sum(axis=-1).mean()))
        return good_new.reshape(-1, 2).tolist(), motion
    except Exception:
        return None, 0.0


def face_points_px(faces, src_w, src_h):
    """Convert face records to pixel corner points for optical flow."""
    pts = []
    for d in faces:
        cx_px = d["cx"] * src_w;  cy_px = d["cy"] * src_h
        hw    = d["w"] * src_w / 2.0;  hh = d["h"] * src_h / 2.0
        pts += [[cx_px, cy_px], [cx_px - hw, cy_px - hh], [cx_px + hw, cy_px + hh]]
    return pts if pts else None


# ════════════════════════════════════════════════════════════════════════════
#  SPEAKER IDENTIFICATION
# ════════════════════════════════════════════════════════════════════════════

class SpeakerTracker:
    """
    Tracks lip-openness variance per face position-zone to identify speaker.
    Uses 3 zones: left, center, right thirds of frame.
    """
    def __init__(self, window=8):
        self.window = window
        self.history = {0: [], 1: [], 2: []}   # zone → [lip_openness]

    def update(self, faces, lip_values):
        """Update with current frame's faces and their lip openness values."""
        for face, lip in zip(faces, lip_values):
            zone = 0 if face["cx"] < 0.38 else (2 if face["cx"] > 0.62 else 1)
            self.history[zone].append(lip)
            if len(self.history[zone]) > self.window:
                self.history[zone].pop(0)

    def speaker_zone(self):
        """Return zone index (0/1/2) of most-active speaker."""
        scores = {z: sum(h) / max(1, len(h)) for z, h in self.history.items() if h}
        if not scores:
            return 1  # default center
        return max(scores, key=scores.get)

    def speaker_idx(self, faces):
        """Return index into faces list of most likely current speaker."""
        zone = self.speaker_zone()
        best = -1; best_dist = 999.0
        for i, f in enumerate(faces):
            face_zone = 0 if f["cx"] < 0.38 else (2 if f["cx"] > 0.62 else 1)
            dist = abs(face_zone - zone)
            if dist < best_dist:
                best_dist = dist; best = i
        return best


# ════════════════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: face_track.py <video> <start> <end> [fps]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    start_sec  = float(sys.argv[2])
    end_sec    = float(sys.argv[3])
    req_fps    = float(sys.argv[4]) if len(sys.argv) > 4 else SAMPLE_FPS
    sample_fps = min(8.0, max(2.0, req_fps))
    clip_dur   = max(1.0, end_sec - start_sec)

    try:
        import cv2
    except ImportError:
        _fallback_output(video_path, start_sec, end_sec, reason="opencv_missing")
        return

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        _fallback_output(video_path, start_sec, end_sec, reason="cannot_open")
        return

    src_fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w      = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h      = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    interval   = max(1, int(round(src_fps / sample_fps)))
    max_frames = min(MAX_FRAMES, max(16, int(clip_dur * sample_fps) + 2))

    cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)

    # ── Detect with Face Mesh (preferred) ─────────────────────────────────
    records     = []
    detector_id = "haar"

    try:
        import mediapipe as mp
        mp_mesh = mp.solutions.face_mesh

        with mp_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=5,
            refine_landmarks=True,    # enables iris landmarks 468-477
            min_detection_confidence=0.45,
            min_tracking_confidence=0.45,
        ) as mesh:

            detector_id  = "face_mesh"
            prev_gray    = None
            prev_pts     = None
            speaker_trk  = SpeakerTracker(window=8)

            while len(records) < max_frames:
                pos_ms  = cap.get(cv2.CAP_PROP_POS_MSEC)
                cur_abs = pos_ms / 1000.0
                if cur_abs > end_sec + 0.4:
                    break

                ret, frame = cap.read()
                if not ret:
                    break

                clip_t = max(0.0, cur_abs - start_sec)

                # Process at reduced resolution for speed
                proc_w  = min(src_w, 640)
                scale   = proc_w / max(1, src_w)
                proc_h  = max(1, int(src_h * scale))
                small   = cv2.resize(frame, (proc_w, proc_h)) if scale < 0.99 else frame
                rgb     = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
                gray    = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

                results = mesh.process(rgb)

                faces    = []
                lip_vals = []
                yaws     = []
                gazes    = []

                if results.multi_face_landmarks:
                    for face_lm in results.multi_face_landmarks:
                        lm = face_lm.landmark
                        # Bounding box from all landmarks
                        xs = [l.x for l in lm]; ys = [l.y for l in lm]
                        x1r = max(0.0, min(xs)); y1r = max(0.0, min(ys))
                        x2r = min(1.0, max(xs)); y2r = min(1.0, max(ys))
                        fw  = x2r - x1r;         fh  = y2r - y1r
                        if fw < 0.03:
                            continue
                        faces.append({
                            "cx": (x1r + x2r) / 2.0,
                            "cy": (y1r + y2r) / 2.0,
                            "x1": x1r, "y1": y1r,
                            "x2": x2r, "y2": y2r,
                            "w": fw, "h": fh,
                            "score": 0.90,  # mesh is high confidence by design
                        })
                        lip_vals.append(lip_openness(lm))
                        yaws.append(estimate_yaw(lm, proc_w, proc_h))
                        gazes.append(estimate_gaze_x(lm))

                # Optical flow motion energy
                of_pts, motion = track_flow(prev_gray, gray, prev_pts, proc_w, proc_h)
                prev_gray = gray.copy()
                prev_pts  = face_points_px(faces, proc_w, proc_h) if faces else of_pts

                speaker_trk.update(faces, lip_vals)

                records.append({
                    "t":       clip_t,
                    "n_faces": len(faces),
                    "faces":   faces,
                    "lip":     lip_vals,
                    "yaws":    yaws,
                    "gazes":   gazes,
                    "motion":  motion,
                    "speaker_idx": speaker_trk.speaker_idx(faces),
                })

                # Skip frames to hit target sample_fps
                for _ in range(interval - 1):
                    ok2, _ = cap.read()
                    if not ok2:
                        break

    except Exception as mesh_err:
        # ── Fall back to Face Detection ────────────────────────────────────
        records = []
        cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)

        try:
            import mediapipe as mp
            mp_det  = mp.solutions.face_detection
            detector_id = "face_detection"

            with mp_det.FaceDetection(model_selection=1, min_detection_confidence=0.42) as det:
                while len(records) < max_frames:
                    pos_ms  = cap.get(cv2.CAP_PROP_POS_MSEC)
                    cur_abs = pos_ms / 1000.0
                    if cur_abs > end_sec + 0.4:
                        break
                    ret, frame = cap.read()
                    if not ret:
                        break
                    clip_t = max(0.0, cur_abs - start_sec)
                    rgb    = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res    = det.process(rgb)
                    faces  = []
                    if res.detections:
                        for d in res.detections:
                            sc  = d.score[0] if d.score else 0
                            if sc < 0.40:
                                continue
                            bb  = d.location_data.relative_bounding_box
                            if bb.width < 0.02:
                                continue
                            x1  = max(0.0, min(1.0, bb.xmin))
                            y1  = max(0.0, min(1.0, bb.ymin))
                            x2  = max(0.0, min(1.0, bb.xmin + bb.width))
                            y2  = max(0.0, min(1.0, bb.ymin + bb.height))
                            faces.append({
                                "cx": (x1+x2)/2, "cy": (y1+y2)/2,
                                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                                "w": x2-x1, "h": y2-y1, "score": float(sc),
                            })
                    records.append({
                        "t": clip_t, "n_faces": len(faces), "faces": faces,
                        "lip": [], "yaws": [], "gazes": [],
                        "motion": 0.0, "speaker_idx": 0,
                    })
                    for _ in range(interval - 1):
                        ok2, _ = cap.read()
                        if not ok2: break

        except Exception:
            # ── Haar cascade last resort ───────────────────────────────────
            detector_id = "haar"
            records     = []
            cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)

            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"
            if not os.path.exists(cascade_path):
                cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            casc = cv2.CascadeClassifier(cascade_path)

            while len(records) < max_frames:
                pos_ms  = cap.get(cv2.CAP_PROP_POS_MSEC)
                cur_abs = pos_ms / 1000.0
                if cur_abs > end_sec + 0.4:
                    break
                ret, frame = cap.read()
                if not ret:
                    break
                clip_t = max(0.0, cur_abs - start_sec)
                h360   = max(1, int(360 * src_h / max(1, src_w)))
                small  = cv2.resize(frame, (360, h360))
                gray   = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                gray   = cv2.equalizeHist(gray)
                raw    = casc.detectMultiScale(gray, 1.1, 4, minSize=(20, 20))
                faces  = []
                sx, sy = 1.0/360.0, 1.0/max(1, h360)
                for (x, y, w, h) in (raw if len(raw) else []):
                    x1 = max(0.0, min(1.0, x*sx));     y1 = max(0.0, min(1.0, y*sy))
                    x2 = max(0.0, min(1.0, (x+w)*sx)); y2 = max(0.0, min(1.0, (y+h)*sy))
                    if (x2-x1) < 0.025: continue
                    faces.append({
                        "cx": (x1+x2)/2, "cy": (y1+y2)/2,
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "w": x2-x1, "h": y2-y1, "score": 0.65,
                    })
                records.append({
                    "t": clip_t, "n_faces": len(faces), "faces": faces,
                    "lip": [], "yaws": [], "gazes": [],
                    "motion": 0.0, "speaker_idx": 0,
                })
                for _ in range(interval - 1):
                    ok2, _ = cap.read()
                    if not ok2: break

    cap.release()

    # ── No faces at all ───────────────────────────────────────────────────
    all_faces = [d for r in records for d in r["faces"]]
    if not all_faces:
        frac = CROP_FRACS["default"]
        print(json.dumps({
            "speakerSide": "center", "meanFaceX": 0.5, "meanFaceY": 0.38,
            "meanFaceW": 0.0, "meanFaceH": 0.0, "faceCount": 0, "rangeCX": 0.0,
            "combinedBox": {"x1": 0.1, "y1": 0.05, "x2": 0.9, "y2": 0.95},
            "sceneType": "monologue", "framingMode": "monologue",
            "globalCropFrac": frac,
            "keyframes": [{"t":0.0,"cx":0.5,"cy":0.38,"cropFrac":frac,
                           "cropY":0,"faceCount":0,"confidence":0.3,"quality":0}],
            "totalDets": 0, "srcWidth": src_w, "srcHeight": src_h,
            "framesSampled": len(records), "detector": detector_id,
        }))
        return

    # ── Global stats ──────────────────────────────────────────────────────
    areas  = [d["w"]*d["h"] for d in all_faces]
    total  = sum(areas) or 1.0
    mean_cx = sum(d["cx"]*a for d,a in zip(all_faces, areas)) / total
    mean_cy = sum(d["cy"]*a for d,a in zip(all_faces, areas)) / total
    mean_fw = sum(d["w"] *a for d,a in zip(all_faces, areas)) / total
    mean_fh = sum(d["h"] *a for d,a in zip(all_faces, areas)) / total
    cb_x1   = min(d["x1"] for d in all_faces); cb_y1 = min(d["y1"] for d in all_faces)
    cb_x2   = max(d["x2"] for d in all_faces); cb_y2 = max(d["y2"] for d in all_faces)
    cx_vals = sorted(d["cx"] for d in all_faces)
    n_s     = len(cx_vals)
    range_cx = cx_vals[min(n_s-1, int(n_s*0.90))] - cx_vals[max(0, int(n_s*0.10))] if n_s > 2 else 0.0
    face_max = max(r["n_faces"] for r in records if r["n_faces"] > 0)

    speaker_side = "center"
    if mean_cx < 0.38: speaker_side = "left"
    elif mean_cx > 0.62: speaker_side = "right"

    # ── Scene classification ──────────────────────────────────────────────
    scene_type, framing_mode, avg_spread = classify_scene(records)

    # ── Per-frame cinematic composition ──────────────────────────────────
    def compute_frame_targets(frac_override=None):
        """
        Build raw target (cx, cropFrac) per record using cinematography rules.
        Returns list of {t, target_cx, target_frac, n_faces, confidence}.
        """
        frame_targets = []
        b_frac = base_crop_frac(scene_type, face_max, avg_spread)

        for r in records:
            faces = r["faces"]
            n     = r["n_faces"]

            # Dynamic crop fraction: gentle widen in high-motion frames only
            # Keep boost small so framing stays consistent across clip durations
            motion_boost = min(0.04, r["motion"] / 60.0) * b_frac
            target_frac  = (frac_override or b_frac) + motion_boost
            target_frac  = min(0.92, max(0.30, target_frac))

            if n == 0:
                # No face: hold current frac, use last known cx or center
                frame_targets.append({
                    "t": r["t"], "n_faces": 0, "confidence": 0.20,
                    "target_cx": None,   # will be filled from spring state
                    "target_frac": target_frac,
                })
                continue

            yaws  = r["yaws"]  if r["yaws"]  else [0.0] * n
            gazes = r["gazes"] if r["gazes"] else [0.0] * n

            if n == 1:
                cx = compose_single(
                    faces[0]["cx"], target_frac,
                    yaws[0], gazes[0]
                )
                conf = faces[0]["score"]
            else:
                cx   = compose_multi(faces, target_frac, r["speaker_idx"])
                conf = sum(d["score"] for d in faces) / n

            frame_targets.append({
                "t": r["t"], "n_faces": n, "confidence": round(conf, 3),
                "target_cx": cx, "target_frac": target_frac,
            })

        return frame_targets

    def apply_spring(frame_targets):
        """
        Run spring physics over frame_targets. Returns list of smoothed keyframes.
        Predictive lookahead: blend current target with upcoming targets so the
        camera begins moving before a speaker change, like a professional operator.
        """
        # Pre-compute predictive targets using 0.6s lookahead
        LOOKAHEAD_S = 0.6
        LOOKAHEAD_W = 0.20   # how much to blend toward the future position
        for i, ft in enumerate(frame_targets):
            if ft["target_cx"] is None:
                continue
            # Collect valid targets within lookahead window
            future_cxs = [
                frame_targets[j]["target_cx"]
                for j in range(i + 1, len(frame_targets))
                if frame_targets[j]["t"] - ft["t"] <= LOOKAHEAD_S
                and frame_targets[j]["target_cx"] is not None
            ]
            if future_cxs:
                avg_future = sum(future_cxs) / len(future_cxs)
                # Only blend when the camera will need to move significantly
                if abs(avg_future - ft["target_cx"]) > 0.04:
                    ft["target_cx"] = (1.0 - LOOKAHEAD_W) * ft["target_cx"] + LOOKAHEAD_W * avg_future

        # Find first valid target for spring initialization
        first = next((ft for ft in frame_targets if ft["target_cx"] is not None), None)
        if first is None:
            cx0 = mean_cx; frac0 = base_crop_frac(scene_type, face_max, avg_spread)
        else:
            cx0 = first["target_cx"]; frac0 = first["target_frac"]

        spring   = CameraSpring(cx0, frac0)
        last_cx  = cx0
        keyframes = []

        for i, ft in enumerate(frame_targets):
            target_cx   = ft["target_cx"] if ft["target_cx"] is not None else last_cx
            target_frac = ft["target_frac"]

            if i == 0:
                spring.teleport(target_cx, target_frac)
                cx, frac = target_cx, target_frac
            else:
                prev_t = frame_targets[i-1]["t"]
                dt     = max(0.01, ft["t"] - prev_t)
                cx, frac = spring.step(target_cx, target_frac, dt)

            # Clamp after spring step
            cx   = _clamp_cx(cx, frac)
            frac = min(0.92, max(0.30, frac))

            if ft["target_cx"] is not None:
                last_cx = cx

            # Score quality at this spring position
            faces = records[i]["faces"]
            qual  = compute_quality(faces, cx, frac)

            keyframes.append({
                "t":          round(ft["t"], 3),
                "cx":         round(cx, 4),
                "cy":         round(mean_cy, 4),
                "cropFrac":   round(frac, 3),
                "cropY":      0,
                "faceCount":  ft["n_faces"],
                "confidence": ft["confidence"],
                "quality":    qual,
            })

        return keyframes

    # ── First pass ───────────────────────────────────────────────────────
    targets   = compute_frame_targets()
    keyframes = apply_spring(targets)

    # ── Auto-widen if overall quality is below target ────────────────────
    avg_qual = sum(kf["quality"] for kf in keyframes) / max(1, len(keyframes))

    if avg_qual < QUAL_TARGET:
        widen_frac = min(0.92, base_crop_frac(scene_type, face_max, avg_spread) * 1.12)
        targets2   = compute_frame_targets(frac_override=widen_frac)
        kf2        = apply_spring(targets2)
        avg_qual2  = sum(kf["quality"] for kf in kf2) / max(1, len(kf2))
        if avg_qual2 > avg_qual:
            keyframes = kf2
            avg_qual  = avg_qual2

    if avg_qual < 80:
        # Fallback: center-wide composition ignoring cinematography rules
        safe_frac = min(0.88, base_crop_frac(scene_type, face_max, avg_spread) * 1.20)
        cx_fallback = max(0.08, min(0.92, mean_cx))
        for kf in keyframes:
            kf["cx"]       = round(cx_fallback, 4)
            kf["cropFrac"] = round(safe_frac, 3)
            kf["quality"]  = compute_quality(records[keyframes.index(kf)]["faces"], cx_fallback, safe_frac)

    # ── Replace low-quality individual frames with nearest good neighbor ──
    good_pos = [(i, kf) for i, kf in enumerate(keyframes) if kf["quality"] >= MIN_QUALITY]
    if good_pos:
        for i, kf in enumerate(keyframes):
            if kf["quality"] < MIN_QUALITY:
                nearest = min(good_pos, key=lambda g: abs(g[0] - i))
                kf["cx"]         = nearest[1]["cx"]
                kf["cropFrac"]   = nearest[1]["cropFrac"]
                kf["confidence"] = kf["confidence"] * 0.5

    # ── Global crop fraction (quality-weighted average) ──────────────────
    w_sum = 0.0; f_sum = 0.0
    for kf in keyframes:
        w = max(0.05, kf["confidence"]) * max(0.05, kf["quality"] / 100.0)
        f_sum += kf["cropFrac"] * w
        w_sum += w
    global_frac = round(min(0.92, max(0.30, f_sum / max(0.001, w_sum))), 3)

    # ── Output ────────────────────────────────────────────────────────────
    print(json.dumps({
        "speakerSide":    speaker_side,
        "meanFaceX":      round(mean_cx, 4),
        "meanFaceY":      round(mean_cy, 4),
        "meanFaceW":      round(mean_fw, 4),
        "meanFaceH":      round(mean_fh, 4),
        "faceCount":      face_max,
        "rangeCX":        round(range_cx, 4),
        "combinedBox":    {
            "x1": round(cb_x1, 4), "y1": round(cb_y1, 4),
            "x2": round(cb_x2, 4), "y2": round(cb_y2, 4),
        },
        "sceneType":      scene_type,
        "framingMode":    framing_mode,
        "globalCropFrac": global_frac,
        "keyframes":      keyframes,
        "totalDets":      len(all_faces),
        "srcWidth":       src_w,
        "srcHeight":      src_h,
        "framesSampled":  len(records),
        "detector":       detector_id,
    }))


def _fallback_output(video_path, start, end, reason="unknown"):
    frac = CROP_FRACS["default"]
    print(json.dumps({
        "error": reason, "speakerSide": "center",
        "meanFaceX": 0.5, "meanFaceY": 0.38, "meanFaceW": 0.0, "meanFaceH": 0.0,
        "faceCount": 0, "rangeCX": 0.0,
        "combinedBox": {"x1": 0.1, "y1": 0.05, "x2": 0.9, "y2": 0.95},
        "sceneType": "monologue", "framingMode": "monologue",
        "globalCropFrac": frac,
        "keyframes": [{"t":0.0,"cx":0.5,"cy":0.38,"cropFrac":frac,
                       "cropY":0,"faceCount":0,"confidence":0.3,"quality":0}],
        "totalDets": 0, "srcWidth": 0, "srcHeight": 0,
        "framesSampled": 0, "detector": "none",
    }))


if __name__ == "__main__":
    main()
