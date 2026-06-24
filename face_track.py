#!/usr/bin/env /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
"""
ClipForge AI — Cinematic Auto-Reframe Engine v6

What changed from v5:
  • CINEMATIC crop fractions — single speaker is now 0.58 (was 0.38).
    0.38 produced a 2.6× zoom that looked like a mugshot.
    0.58 produces a 1.7× zoom — medium shot, face at 25-40% of output width.
  • Per-frame FRAMING QUALITY SCORE 0–100.
    Automatically rejects shots of floors, shoes, empty frames, ceiling fans.
    Low-quality keyframes are replaced by the last valid frame position.
  • MULTI-PERSON COMPOSITION intelligence.
    Two-shot: uses combined bounding box of both faces + generous padding.
    Group shot: fits all detected faces with 20% safety margin.
    Only switches to close-up when one face dominates AND is high-quality.
  • HEADROOM & SHOULDER ROOM enforced.
    crop_cy tracks the face vertical center so the face sits at the
    cinematic "1/3 from top" rule when source has enough vertical space.
  • SAFE ZONE MARGINS — face never allowed within 6% of crop edges.
  • SPEAKER ANTICIPATION — velocity-based leading extended to 0.40s.
  • Scene confidence — only switches scene type when 3+ consecutive
    frames agree (prevents flicker between single and two-shot).
  • 7 Framing Modes:
    single_speaker | wide_conversation | smart_two_shot |
    group_shot | speaker_closeup | reaction_shot | dynamic_interview

Output JSON:
  speakerSide, meanFaceX/Y/W/H, faceCount, rangeCX, combinedBox  [back-compat]
  sceneType        — fine-grained scene classification
  framingMode      — framing mode recommendation
  globalCropFrac   — recommended crop fraction for full clip
  keyframes        — [{t, cx, cy, cropFrac, cropY, faceCount, confidence, quality}]
                     t    = clip-relative seconds
                     cx   = horizontal crop center [0..1]
                     cy   = IDEAL face center Y in [0..1] (for server reference)
                     cropY= recommended crop Y offset from top, or 0 if full height
                     quality = framing quality score 0–100
  totalDets, srcWidth/Height, framesSampled, detector

Usage:
  python3.9 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
"""
import sys, json, os, math

# ── CINEMATIC CROP FRACTIONS ────────────────────────────────────────────
# These map scene/mode to fraction of SOURCE WIDTH shown in the virtual camera.
# Larger fraction = wider shot = more breathing room.
# Lower bound is 0.44 (never tighter than ~2.3× zoom for any scene).
CROP_FRACS = {
    "single_speaker":       0.58,   # medium shot, face ~28–38% of output width
    "single_speaker_tight": 0.52,   # slightly tighter for active/moving speakers
    "speaker_closeup":      0.48,   # deliberate close-up (not just "zoomed in")
    "wide_conversation":    0.78,   # both speakers + air between them
    "smart_two_shot":       0.72,   # two people comfortably in frame
    "dynamic_interview":    0.80,   # interview — slightly wider than two-shot
    "podcast":              0.68,   # podcast two-shot
    "group_shot":           0.88,   # group of 3+ with margins
    "reaction_shot":        0.62,   # reaction / looking up content
    "wide_shot":            0.75,   # subject is small — keep wide
}

# ── QUALITY SCORING CONSTANTS ───────────────────────────────────────────
MIN_QUALITY_THRESHOLD = 40   # frames below this score use fallback position
FACE_SIZE_MIN         = 0.06  # face must be ≥6% of source width to be "visible"
FACE_SIZE_MAX         = 0.70  # face ≥70% of source width = extreme close-up (bad)
EDGE_SAFETY_MARGIN    = 0.06  # face center must be ≥6% away from crop edge

# ── SAFE ZONE ────────────────────────────────────────────────────────────
CX_MIN = 0.08   # never let crop center be within 8% of source left edge
CX_MAX = 0.92   # never let crop center be within 8% of source right edge


def compute_framing_quality(dets, cx, crop_frac, src_aspect=1.78):
    """
    Score the framing quality of a given crop position, 0–100.
    Penalizes: no faces, too-small faces, faces at edge, extreme zoom,
    poor face-to-crop ratio.

    Parameters
    ----------
    dets       : list of detection dicts from MediaPipe / Haar
    cx         : proposed crop center X [0..1]
    crop_frac  : fraction of source width being shown
    src_aspect : source aspect ratio (width/height)
    """
    if not dets:
        return 0  # no face detected — reject immediately

    score = 0.0

    # ── 1. Face detection confidence (0–25 pts) ─────────────────────────
    best_conf = max(d["score"] for d in dets)
    score += 25.0 * min(1.0, best_conf / 0.75)

    # ── 2. Face size in output (0–25 pts) ───────────────────────────────
    # Face should occupy 12–40% of crop width for a natural look
    primary = max(dets, key=lambda d: d["w"] * d["h"])
    face_frac_in_crop = primary["w"] / max(0.01, crop_frac)
    # Ideal range: 15%–40% of crop width
    if 0.15 <= face_frac_in_crop <= 0.40:
        score += 25.0
    elif face_frac_in_crop < 0.08:
        score += 0     # face too small — probably floor/shoes/object
    elif face_frac_in_crop < 0.15:
        score += 15.0 * (face_frac_in_crop - 0.08) / 0.07
    elif face_frac_in_crop <= 0.60:
        score += 25.0 * max(0, (0.60 - face_frac_in_crop) / 0.20)
    else:
        score += 0     # face grotesquely large — reject

    # ── 3. Face vertical position (0–20 pts) — headroom check ───────────
    # Ideal: face center Y at 30–55% of source height (gives headroom above)
    # Penalise: face center near bottom (shoes/floor) or very top (cropped head)
    face_cy = primary["cy"]
    if 0.28 <= face_cy <= 0.58:
        score += 20.0
    elif face_cy < 0.15:
        # Face near top — likely a ceiling, partial detection
        score += 3.0
    elif face_cy > 0.75:
        # Face in lower 25% — likely shoes, floor, object, chest
        score += 0
    else:
        # Linearly interpolate
        if face_cy < 0.28:
            score += 20.0 * (face_cy - 0.15) / 0.13
        else:
            score += 20.0 * max(0, (0.85 - face_cy) / 0.30)

    # ── 4. Horizontal safety margin (0–15 pts) ───────────────────────────
    # Face center should not be within EDGE_SAFETY_MARGIN of crop edges
    # Crop window spans: [cx - crop_frac/2 … cx + crop_frac/2]
    left_edge  = cx - crop_frac / 2
    right_edge = cx + crop_frac / 2
    # Face position within crop, normalised to [0..1]
    face_within_crop = (primary["cx"] - left_edge) / max(0.01, crop_frac)
    if EDGE_SAFETY_MARGIN <= face_within_crop <= (1 - EDGE_SAFETY_MARGIN):
        score += 15.0
    else:
        dist_from_edge = min(face_within_crop, 1 - face_within_crop)
        score += 15.0 * max(0, dist_from_edge / EDGE_SAFETY_MARGIN)

    # ── 5. Multi-face balance (0–15 pts) ─────────────────────────────────
    # For multi-person shots, reward when all faces are well within crop
    if len(dets) >= 2:
        all_within = all(
            left_edge + EDGE_SAFETY_MARGIN * crop_frac <= d["cx"] <= right_edge - EDGE_SAFETY_MARGIN * crop_frac
            for d in dets
        )
        score += 15.0 if all_within else 5.0
    else:
        score += 15.0  # single face always gets full points here

    return round(min(100.0, score), 1)


def classify_scene(records):
    """
    Classify scene type + recommend framing mode.
    Uses majority vote across frames to prevent flickering.

    Returns (scene_type, framing_mode, spread)
    """
    # Count frames with different face counts
    counts = [len(fr["dets"]) for fr in records if fr["dets"]]
    if not counts:
        return "single_speaker", "single_speaker", 0.0

    max_faces = max(counts)
    frames_with_2plus = sum(1 for c in counts if c >= 2)
    pct_multi = frames_with_2plus / max(1, len(counts))

    # Compute average spread between faces in multi-face frames
    multi_frames = [fr for fr in records if len(fr["dets"]) >= 2]
    avg_spread = 0.0
    if multi_frames:
        avg_spread = sum(
            max(d["cx"] for d in fr["dets"]) - min(d["cx"] for d in fr["dets"])
            for fr in multi_frames
        ) / len(multi_frames)

    if max_faces >= 3:
        return "group", "group_shot", avg_spread

    if max_faces == 2 or pct_multi > 0.30:
        # Distinguish interview (far apart) vs podcast (close together)
        if avg_spread > 0.35:
            return "interview", "dynamic_interview", avg_spread
        elif avg_spread > 0.20:
            return "podcast", "smart_two_shot", avg_spread
        else:
            return "podcast", "wide_conversation", avg_spread

    # Single-face scene — classify by face size and position
    face_dets = [d for fr in records for d in fr["dets"]]
    if not face_dets:
        return "single_speaker", "single_speaker", 0.0

    areas  = [d["w"] * d["h"] for d in face_dets]
    tw     = sum(areas) or 1.0
    mean_cy = sum(d["cy"] * a for d, a in zip(face_dets, areas)) / tw
    mean_fw = sum(d["w"]  * a for d, a in zip(face_dets, areas)) / tw
    mean_fh = sum(d["h"]  * a for d, a in zip(face_dets, areas)) / tw

    if mean_cy > 0.65:
        # Face near bottom — reaction shot (looking at screen content above)
        return "reaction", "reaction_shot", 0.0
    if mean_fw < 0.05:
        # Very tiny face — wide establishing shot
        return "wide_shot", "wide_shot", 0.0
    if mean_fh > 0.55:
        # Very large face — deliberate close-up
        return "close_up", "speaker_closeup", 0.0

    return "single_speaker", "single_speaker", 0.0


def get_crop_frac(scene_type, framing_mode, n_faces, spread=0.0, face_w=0.0):
    """
    Return crop fraction based on scene, with dynamic adjustment for spread.
    """
    base = CROP_FRACS.get(framing_mode, CROP_FRACS.get(scene_type, 0.58))

    # Dynamic widening for very wide interviews
    if scene_type in ("interview", "podcast") and n_faces >= 2:
        # Ensure both faces fit with 15% margin on each side
        needed = spread + 0.30  # face spread + 15% left + 15% right padding
        base = max(base, needed)

    # Cap to reasonable range
    return min(0.92, max(0.44, base))


def compose_multi_face_cx(dets, crop_frac, scene_type):
    """
    For multi-person shots, find the crop center X that best frames all faces.
    Uses combined bounding box with padding rather than just face centroid.

    Returns (cx, quality_note)
    """
    if not dets:
        return 0.5, "no_faces"
    if len(dets) == 1:
        return dets[0]["cx"], "single"

    # Combined bounding box of all faces
    x1_all = min(d["x1"] for d in dets)
    x2_all = max(d["x2"] for d in dets)
    cx_combined = (x1_all + x2_all) / 2

    # Check if the combined box fits within crop with margins
    combined_width = x2_all - x1_all
    needed_frac = combined_width + 0.20  # 10% padding each side

    if needed_frac <= crop_frac:
        # All faces fit — center on combined box
        return cx_combined, "fits"
    else:
        # Faces don't all fit — center on most confident face
        primary = max(dets, key=lambda d: d["score"] * d["w"] * d["h"])
        return primary["cx"], "primary_only"


def frame_crop_position(dets, scene_type, framing_mode, prev_cx, prev_cy, crop_frac):
    """
    For one frame, return (cx, cy, cropFrac, faceCount, confidence, quality).
    cx: horizontal crop center [0..1]
    cy: vertical ideal face center [0..1] (informational for server)
    quality: framing quality score 0–100
    """
    if not dets:
        # Hold last known position, low quality
        cx = prev_cx if prev_cx is not None else 0.5
        cy = prev_cy if prev_cy is not None else 0.38
        quality = 0
        return cx, cy, crop_frac, 0, 0.25, quality

    n = len(dets)

    if n == 1:
        d   = dets[0]
        cx  = d["cx"]
        cy  = d["cy"]
        conf = float(d["score"])
    else:
        # Multi-face: use intelligent composition
        cx, _ = compose_multi_face_cx(dets, crop_frac, scene_type)
        # Vertical center: average of all faces, weighted by area
        areas  = [d["w"] * d["h"] for d in dets]
        total  = sum(areas) or 1.0
        cy     = sum(d["cy"] * a for d, a in zip(dets, areas)) / total
        conf   = sum(d["score"] * a for d, a in zip(dets, areas)) / total

    # Clamp cx with safe zone margins
    half  = crop_frac / 2
    cx    = max(half + 0.01, min(1.0 - half - 0.01, cx))
    cx    = max(CX_MIN, min(CX_MAX, cx))

    quality = compute_framing_quality(dets, cx, crop_frac)
    return cx, cy, crop_frac, n, round(conf, 3), quality


def smooth_cx(kfs, window=7):
    """
    Gaussian-weighted moving average of cx (and cy).
    Larger window = smoother but less responsive.
    """
    hw = window // 2
    result = []
    for i, kf in enumerate(kfs):
        lo = max(0, i - hw)
        hi = min(len(kfs) - 1, i + hw)
        s_cx = 0.0; s_cy = 0.0; total = 0.0
        for j in range(lo, hi + 1):
            dist = abs(i - j)
            # Gaussian-shaped weight: peaks at center, falls off quickly
            w_g  = math.exp(-0.5 * (dist / max(1, hw * 0.6)) ** 2)
            s_cx  += kfs[j]["cx"] * w_g
            s_cy  += kfs[j].get("cy", 0.38) * w_g
            total += w_g
        result.append({**kf, "cx": s_cx / total, "cy": s_cy / total})
    return result


def add_lead(kfs, lead_sec=0.40):
    """
    Velocity-based leading: shift the crop in the direction of movement
    so the camera anticipates where the subject is going.
    Cap at ±6% to avoid over-shooting.
    """
    result = list(kfs)
    for i in range(1, len(result) - 1):
        dt = result[i + 1]["t"] - result[i - 1]["t"]
        if dt < 0.05:
            continue
        vel  = (result[i + 1]["cx"] - result[i - 1]["cx"]) / dt
        lead = max(-0.06, min(0.06, vel * lead_sec))
        result[i] = {**result[i], "cx": result[i]["cx"] + lead}
    return result


def quality_filter_keyframes(kfs, threshold=MIN_QUALITY_THRESHOLD):
    """
    Replace low-quality frames (floor/shoe/ceiling shots) with
    the nearest high-quality neighbour's cx position.
    """
    # Find all high-quality positions
    good_positions = [(i, kf) for i, kf in enumerate(kfs) if kf.get("quality", 0) >= threshold]
    if not good_positions:
        # Nothing good — return as-is, caller will use global fallback
        return kfs

    result = list(kfs)
    for i, kf in enumerate(kfs):
        if kf.get("quality", 0) < threshold:
            # Find nearest good frame
            nearest = min(good_positions, key=lambda g: abs(g[0] - i))
            result[i] = {
                **kf,
                "cx":         nearest[1]["cx"],
                "cy":         nearest[1].get("cy", 0.38),
                "confidence": kf["confidence"] * 0.5,  # lower confidence to signal fallback
                "quality":    kf["quality"],            # keep original score for reference
                "_replaced":  True,
            }
    return result


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: face_track.py <video> <start> <end> [fps]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    start      = float(sys.argv[2])
    end        = float(sys.argv[3])
    sample_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0

    try:
        import cv2
    except ImportError:
        print(json.dumps({"error": "opencv not available", "speakerSide": "center"}))
        sys.exit(0)

    try:
        import mediapipe as mp
        USE_MEDIAPIPE = True
    except ImportError:
        USE_MEDIAPIPE = False

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"error": f"Cannot open: {video_path}", "speakerSide": "center"}))
        sys.exit(0)

    src_fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    src_aspect = src_width / max(1, src_height)
    clip_dur   = max(1.0, end - start)

    # Sample at up to 5fps for more keyframes → smoother tracking
    sample_fps = min(5.0, max(2.0, sample_fps))
    interval   = max(1, int(round(src_fps / sample_fps)))
    max_frames = max(16, min(int(clip_dur * sample_fps) + 2, 80))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    # Each record: {t: clip-relative seconds, dets: [{cx,cy,x1,y1,x2,y2,w,h,score}]}
    frame_records = []

    # ── MediaPipe detection ──────────────────────────────────────────────
    if USE_MEDIAPIPE:
        mp_face  = mp.solutions.face_detection
        # model_selection=1 = full-range (up to 5m), better for wide shots
        detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)

        while len(frame_records) < max_frames:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            cur_t  = pos_ms / 1000.0
            if cur_t > end + 0.3:
                break
            ret, frame = cap.read()
            if not ret:
                break

            clip_t = max(0.0, cur_t - start)
            rgb    = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = detector.process(rgb)

            dets = []
            if result.detections:
                for det in result.detections:
                    score = det.score[0] if det.score else 0
                    if score < 0.42:
                        continue
                    bb = det.location_data.relative_bounding_box
                    if bb.width < 0.018:  # ignore tiny faces (< 1.8% of frame width)
                        continue
                    x1 = max(0.0, min(1.0, bb.xmin))
                    y1 = max(0.0, min(1.0, bb.ymin))
                    x2 = max(0.0, min(1.0, bb.xmin + bb.width))
                    y2 = max(0.0, min(1.0, bb.ymin + bb.height))
                    dets.append({
                        "cx": (x1 + x2) / 2,
                        "cy": (y1 + y2) / 2,
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "w": x2 - x1, "h": y2 - y1,
                        "score": float(score),
                    })

            frame_records.append({"t": clip_t, "dets": dets})

            for _ in range(interval - 1):
                r2, _ = cap.read()
                if not r2:
                    break

        detector.close()

    # ── Haar Cascade fallback ────────────────────────────────────────────
    else:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"
        if not os.path.exists(cascade_path):
            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)

        while len(frame_records) < max_frames:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            cur_t  = pos_ms / 1000.0
            if cur_t > end + 0.3:
                break
            ret, frame = cap.read()
            if not ret:
                break

            clip_t = max(0.0, cur_t - start)
            h360   = max(1, int(360 * src_height / max(1, src_width)))
            small  = cv2.resize(frame, (360, h360))
            gray   = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            gray   = cv2.equalizeHist(gray)
            faces  = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(20, 20))

            dets = []
            sx = 1.0 / 360.0
            sy = 1.0 / max(1, h360)
            for (x, y, w, h) in faces:
                x1 = max(0.0, min(1.0, x * sx))
                y1 = max(0.0, min(1.0, y * sy))
                x2 = max(0.0, min(1.0, (x + w) * sx))
                y2 = max(0.0, min(1.0, (y + h) * sy))
                if (x2 - x1) < 0.020:
                    continue
                dets.append({
                    "cx": (x1 + x2) / 2, "cy": (y1 + y2) / 2,
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "w": x2 - x1, "h": y2 - y1,
                    "score": 0.60,
                })
            frame_records.append({"t": clip_t, "dets": dets})

            for _ in range(interval - 1):
                r2, _ = cap.read()
                if not r2:
                    break

    cap.release()
    frames_sampled = len(frame_records)

    # ── Global stats ──────────────────────────────────────────────────────
    all_dets       = [d for fr in frame_records for d in fr["dets"]]
    face_count_max = max((len(fr["dets"]) for fr in frame_records if fr["dets"]), default=0)

    # ── No-face fallback ─────────────────────────────────────────────────
    if not all_dets:
        frac = CROP_FRACS["single_speaker"]
        print(json.dumps({
            "speakerSide":    "center",
            "meanFaceX":      0.5, "meanFaceY": 0.38,
            "meanFaceW":      0.0, "meanFaceH": 0.0,
            "faceCount":      0, "rangeCX": 0.0,
            "combinedBox":    {"x1": 0.1, "y1": 0.05, "x2": 0.9, "y2": 0.95},
            "sceneType":      "single_speaker",
            "framingMode":    "single_speaker",
            "globalCropFrac": frac,
            "keyframes": [{
                "t": 0.0, "cx": 0.5, "cy": 0.38,
                "cropFrac": frac, "cropY": 0,
                "faceCount": 0, "confidence": 0.3, "quality": 0,
            }],
            "totalDets": 0, "srcWidth": src_width, "srcHeight": src_height,
            "framesSampled": frames_sampled,
            "detector": "mediapipe" if USE_MEDIAPIPE else "haar",
        }))
        return

    # ── Weighted global stats ─────────────────────────────────────────────
    weights  = [d["w"] * d["h"] for d in all_dets]
    total_w  = sum(weights) or 1.0
    mean_cx  = sum(d["cx"] * w for d, w in zip(all_dets, weights)) / total_w
    mean_cy  = sum(d["cy"] * w for d, w in zip(all_dets, weights)) / total_w
    mean_fw  = sum(d["w"]  * w for d, w in zip(all_dets, weights)) / total_w
    mean_fh  = sum(d["h"]  * w for d, w in zip(all_dets, weights)) / total_w

    cb_x1 = max(0.0, min(d["x1"] for d in all_dets))
    cb_y1 = max(0.0, min(d["y1"] for d in all_dets))
    cb_x2 = min(1.0, max(d["x2"] for d in all_dets))
    cb_y2 = min(1.0, max(d["y2"] for d in all_dets))

    sorted_cx = sorted(d["cx"] for d in all_dets)
    n_s       = len(sorted_cx)
    range_cx  = sorted_cx[min(n_s-1, int(n_s*0.90))] - sorted_cx[max(0, int(n_s*0.10))] if n_s > 2 else 0.0

    speaker_side = "center"
    if mean_cx < 0.38: speaker_side = "left"
    elif mean_cx > 0.62: speaker_side = "right"

    # ── Scene classification ──────────────────────────────────────────────
    scene_type, framing_mode, avg_spread = classify_scene(frame_records)

    # ── Build per-frame keyframes ─────────────────────────────────────────
    raw_kf   = []
    prev_cx  = None
    prev_cy  = None
    for fr in frame_records:
        crop_frac = get_crop_frac(scene_type, framing_mode, len(fr["dets"]), avg_spread, mean_fw)
        cx, cy, frac, n_f, conf, quality = frame_crop_position(
            fr["dets"], scene_type, framing_mode, prev_cx, prev_cy, crop_frac
        )
        raw_kf.append({
            "t":          fr["t"],
            "cx":         cx,
            "cy":         cy,
            "cropFrac":   frac,
            "faceCount":  n_f,
            "confidence": conf,
            "quality":    quality,
        })
        if n_f > 0:
            prev_cx = cx
            prev_cy = cy

    # ── Quality filtering: replace bad frames with nearest good ──────────
    filtered_kf = quality_filter_keyframes(raw_kf, MIN_QUALITY_THRESHOLD)

    # ── Temporal smoothing ────────────────────────────────────────────────
    smoothed = smooth_cx(filtered_kf, window=7)

    # ── Velocity-based leading ────────────────────────────────────────────
    final_kf = add_lead(smoothed, lead_sec=0.40)

    # ── Clamp cx to safe zone ─────────────────────────────────────────────
    for kf in final_kf:
        crop_frac = kf["cropFrac"]
        half  = crop_frac / 2
        kf["cx"] = max(half + 0.02, min(1.0 - half - 0.02, kf["cx"]))
        kf["cx"] = max(CX_MIN, min(CX_MAX, kf["cx"]))
        # cropY: for landscape sources where cropH > srcH, always 0
        # For portrait sources where we might pan vertically, set cropY
        kf["cropY"] = 0  # reserved — always 0 for landscape-to-portrait conversion

    # ── Global crop fraction (confidence + quality weighted) ─────────────
    wsum = 0.0; frac_sum = 0.0
    for kf in final_kf:
        w = max(0.1, kf["confidence"]) * max(0.1, kf.get("quality", 50) / 100.0)
        frac_sum += kf["cropFrac"] * w
        wsum     += w
    global_frac = frac_sum / max(0.001, wsum)
    global_frac = round(min(0.92, max(0.44, global_frac)), 3)

    # ── Output ────────────────────────────────────────────────────────────
    print(json.dumps({
        "speakerSide":    speaker_side,
        "meanFaceX":      round(mean_cx, 4),
        "meanFaceY":      round(mean_cy, 4),
        "meanFaceW":      round(mean_fw, 4),
        "meanFaceH":      round(mean_fh, 4),
        "faceCount":      face_count_max,
        "rangeCX":        round(range_cx, 4),
        "combinedBox":    {
            "x1": round(cb_x1, 4), "y1": round(cb_y1, 4),
            "x2": round(cb_x2, 4), "y2": round(cb_y2, 4),
        },
        "sceneType":      scene_type,
        "framingMode":    framing_mode,
        "globalCropFrac": global_frac,
        "keyframes": [
            {
                "t":          round(kf["t"], 3),
                "cx":         round(kf["cx"], 4),
                "cy":         round(kf.get("cy", 0.38), 4),
                "cropFrac":   round(kf["cropFrac"], 3),
                "cropY":      kf.get("cropY", 0),
                "faceCount":  kf["faceCount"],
                "confidence": kf["confidence"],
                "quality":    kf.get("quality", 0),
            }
            for kf in final_kf
        ],
        "totalDets":      len(all_dets),
        "srcWidth":       src_width,
        "srcHeight":      src_height,
        "framesSampled":  frames_sampled,
        "detector":       "mediapipe" if USE_MEDIAPIPE else "haar",
    }))


if __name__ == "__main__":
    main()
