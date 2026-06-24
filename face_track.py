#!/usr/bin/env /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
"""
ClipForge AI — Smart Auto-Reframe Engine v5

New in v5:
  • Per-frame temporal keyframes for smooth virtual camera tracking
  • Scene type classification: single_speaker / interview / podcast / group / reaction
  • Velocity-based motion prediction (camera leads the subject)
  • Gaussian smoothing to eliminate jitter
  • Composition scoring per keyframe
  • Dynamic crop fraction per scene (wider for group, tighter for close-up)

Output (JSON to stdout):
  speakerSide, meanFaceX/Y/W/H, faceCount, rangeCX, combinedBox  — global stats (back-compat)
  sceneType           — scene classification
  keyframes           — list of {t, cx, cropFrac, faceCount, confidence}
                        t is CLIP-RELATIVE (0 = clip start)
  globalCropFrac      — recommended crop fraction for the full clip
  srcWidth/srcHeight, framesSampled, totalDets, detector

Usage:
  python3.9 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
"""
import sys, json, os, math

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
    clip_dur   = max(1.0, end - start)

    interval   = max(1, int(round(src_fps / sample_fps)))
    max_frames = max(12, min(int(clip_dur * sample_fps) + 2, 60))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    # Each record: {t: clip-relative seconds, dets: [{cx,cy,x1,y1,x2,y2,w,h,score}]}
    frame_records = []

    if USE_MEDIAPIPE:
        mp_face  = mp.solutions.face_detection
        detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.48)

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
                    bb    = det.location_data.relative_bounding_box
                    if score < 0.44 or bb.width < 0.022:
                        continue
                    x1 = max(0.0, min(1.0, bb.xmin))
                    y1 = max(0.0, min(1.0, bb.ymin))
                    x2 = max(0.0, min(1.0, bb.xmin + bb.width))
                    y2 = max(0.0, min(1.0, bb.ymin + bb.height))
                    dets.append({
                        "cx": (x1+x2)/2, "cy": (y1+y2)/2,
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "w": x2-x1, "h": y2-y1,
                        "score": float(score),
                    })

            frame_records.append({"t": clip_t, "dets": dets})

            for _ in range(interval - 1):
                r2, _ = cap.read()
                if not r2:
                    break

        detector.close()

    else:
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_alt2.xml'
        if not os.path.exists(cascade_path):
            cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
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
            faces  = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(18, 18))

            dets = []
            sx = 1.0 / 360.0
            sy = 1.0 / max(1, h360)
            for (x, y, w, h) in faces:
                x1 = max(0.0, min(1.0, x * sx))
                y1 = max(0.0, min(1.0, y * sy))
                x2 = max(0.0, min(1.0, (x + w) * sx))
                y2 = max(0.0, min(1.0, (y + h) * sy))
                if (x2 - x1) < 0.022:
                    continue
                dets.append({
                    "cx": (x1+x2)/2, "cy": (y1+y2)/2,
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "w": x2-x1, "h": y2-y1,
                    "score": 0.60,
                })
            frame_records.append({"t": clip_t, "dets": dets})

            for _ in range(interval - 1):
                r2, _ = cap.read()
                if not r2:
                    break

    cap.release()
    frames_sampled = len(frame_records)

    # ── Global stats ──────────────────────────────────────────────────
    all_dets       = [d for fr in frame_records for d in fr["dets"]]
    face_count_max = max((len(fr["dets"]) for fr in frame_records if fr["dets"]), default=0)

    # Default output for no-face case
    if not all_dets:
        print(json.dumps({
            "speakerSide":   "center",
            "meanFaceX":     0.5,
            "meanFaceY":     0.38,
            "meanFaceW":     0.0,
            "meanFaceH":     0.0,
            "faceCount":     0,
            "rangeCX":       0.0,
            "combinedBox":   {"x1": 0.15, "y1": 0.05, "x2": 0.85, "y2": 0.90},
            "sceneType":     "single_speaker",
            "globalCropFrac": 0.40,
            "keyframes":     [{"t": 0.0, "cx": 0.5, "cropFrac": 0.40, "faceCount": 0, "confidence": 0.3}],
            "totalDets":     0,
            "srcWidth":      src_width,
            "srcHeight":     src_height,
            "framesSampled": frames_sampled,
            "detector":      "mediapipe" if USE_MEDIAPIPE else "haar",
        }))
        return

    # Weighted averages (larger face = closer camera = more weight)
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
    n = len(sorted_cx)
    lo_idx    = max(0, int(n * 0.10))
    hi_idx    = min(n - 1, int(n * 0.90))
    range_cx  = sorted_cx[hi_idx] - sorted_cx[lo_idx] if n > 2 else 0.0

    speaker_side = "center"
    if mean_cx < 0.38:
        speaker_side = "left"
    elif mean_cx > 0.62:
        speaker_side = "right"

    # ── Scene type detection ─────────────────────────────────────────
    def classify_scene(records, max_faces_v, range_cx_v, mean_fw_v, mean_cy_v, mean_fh_v):
        frames_with_multi = sum(1 for fr in records if len(fr["dets"]) >= 2)
        pct_multi         = frames_with_multi / max(1, len(records))

        if max_faces_v >= 3:
            return "group"

        if max_faces_v == 2 or pct_multi > 0.25:
            # Check how far apart faces are (interview = opposite sides)
            multi_frs = [fr for fr in records if len(fr["dets"]) >= 2]
            if multi_frs:
                avg_spread = sum(
                    max(d["cx"] for d in fr["dets"]) - min(d["cx"] for d in fr["dets"])
                    for fr in multi_frs
                ) / len(multi_frs)
                return "interview" if avg_spread > 0.28 else "podcast"
            return "podcast"

        # Single-face scene
        if mean_cy_v > 0.58:         return "reaction"     # face in lower half (looking up at content)
        if mean_fw_v < 0.06:         return "wide_shot"    # tiny face — wide establishing shot
        if mean_fh_v > 0.45:         return "close_up"     # very large face — extreme close-up
        return "single_speaker"

    scene_type = classify_scene(frame_records, face_count_max, range_cx, mean_fw, mean_cy, mean_fh)

    # ── Crop fraction per scene ─────────────────────────────────────
    def scene_crop_frac(scene_v, n_faces, spread=0.0):
        """Recommended fraction of source WIDTH to show in virtual camera."""
        if scene_v == "group":
            return 0.62
        if scene_v == "interview":
            return 0.54 if spread > 0.40 else 0.50
        if scene_v == "podcast":
            return 0.48
        if scene_v == "reaction":
            return 0.52
        if scene_v == "wide_shot":
            return 0.42
        if scene_v == "close_up":
            return 0.44   # already close, pull back slightly
        # single_speaker
        return 0.38

    # ── Per-frame crop center X ──────────────────────────────────────
    def frame_crop_center_and_frac(dets, scene_v, prev_cx=None):
        """
        Given detections in one frame, return (cx, cropFrac, faceCount, confidence).
        cx is in [0..1] (source frame center of the crop window).
        """
        if not dets:
            # No detection: hold last known position
            return (prev_cx if prev_cx is not None else 0.5), scene_crop_frac(scene_v, 0), 0, 0.30

        if len(dets) == 1:
            # Single face: center on it with mild centering bias
            cx   = dets[0]["cx"] * 0.88 + 0.5 * 0.12
            frac = scene_crop_frac(scene_v, 1)
            return cx, frac, 1, float(dets[0]["score"])

        # Multiple faces: center of mass weighted by face area
        areas = [d["w"] * d["h"] for d in dets]
        total = sum(areas) or 1.0
        cx_w  = sum(d["cx"] * a for d, a in zip(dets, areas)) / total

        # Compute spread to determine if everyone fits
        spread = max(d["cx"] for d in dets) - min(d["cx"] for d in dets)

        # For groups far apart, we need a wider crop fraction
        if spread > 0.45:
            frac = min(0.68, scene_crop_frac(scene_v, len(dets), spread) + 0.08)
        else:
            frac = scene_crop_frac(scene_v, len(dets), spread)

        # Confidence = average score
        avg_score = sum(d["score"] for d in dets) / len(dets)
        return cx_w, frac, len(dets), avg_score

    # Build raw keyframes
    raw_kf  = []
    prev_cx = None
    for fr in frame_records:
        cx, frac, n_f, conf = frame_crop_center_and_frac(fr["dets"], scene_type, prev_cx)
        raw_kf.append({
            "t":          fr["t"],
            "cx":         cx,
            "cropFrac":   frac,
            "faceCount":  n_f,
            "confidence": round(conf, 3),
        })
        if n_f > 0:
            prev_cx = cx

    # ── Temporal smoothing (Gaussian-like moving window) ─────────────
    def smooth_cx(kfs, window=5):
        """Smooth crop center positions to eliminate detection jitter."""
        hw     = window // 2
        result = []
        for i, kf in enumerate(kfs):
            lo = max(0, i - hw)
            hi = min(len(kfs) - 1, i + hw)
            s_cx = 0.0; total = 0.0
            for j in range(lo, hi + 1):
                dist = abs(i - j)
                w_g  = max(0.05, 1.0 - dist / (hw + 1))
                s_cx  += kfs[j]["cx"] * w_g
                total += w_g
            result.append({**kf, "cx": s_cx / total})
        return result

    smoothed = smooth_cx(raw_kf, window=5)

    # ── Velocity-based motion prediction (lead the subject) ──────────
    def add_lead(kfs, lead_sec=0.35):
        """
        Shift crop center slightly in the direction the subject is moving.
        This makes the camera anticipate movement instead of reacting late.
        """
        result = list(kfs)
        for i in range(1, len(result) - 1):
            dt = result[i + 1]["t"] - result[i - 1]["t"]
            if dt < 0.05:
                continue
            vel   = (result[i + 1]["cx"] - result[i - 1]["cx"]) / dt
            # Cap lead offset to ±5% of frame width
            lead  = max(-0.05, min(0.05, vel * lead_sec))
            result[i] = {**result[i], "cx": result[i]["cx"] + lead}
        return result

    final_kf = add_lead(smoothed, lead_sec=0.30)

    # Clamp all cx to valid range [0.06, 0.94] — never touch edges
    for kf in final_kf:
        kf["cx"] = max(0.06, min(0.94, kf["cx"]))

    # ── Global crop fraction (weighted average across keyframes) ──────
    kf_weight  = sum(max(1, kf["faceCount"]) * kf["confidence"] for kf in final_kf)
    global_frac = sum(kf["cropFrac"] * max(1, kf["faceCount"]) * kf["confidence"]
                      for kf in final_kf) / max(0.001, kf_weight)
    global_frac = round(min(0.70, max(0.32, global_frac)), 3)

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
        "globalCropFrac": global_frac,
        "keyframes":      [
            {
                "t":          round(kf["t"], 3),
                "cx":         round(kf["cx"], 4),
                "cropFrac":   round(kf["cropFrac"], 3),
                "faceCount":  kf["faceCount"],
                "confidence": kf["confidence"],
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
