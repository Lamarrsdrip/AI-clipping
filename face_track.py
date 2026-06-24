#!/usr/bin/env /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
"""
ClipForge AI — Smart Auto-Reframe Engine v3

Detects ALL faces across the clip and returns rich framing data:
  • Per-detection bounding boxes (all faces, all frames)
  • Combined bounding box = union of every face seen (the region we MUST show)
  • Average face size relative to frame (tells how close camera already is)
  • Max simultaneous face count (drives zoom-out for multi-person scenes)
  • Temporal camera range (how much faces move horizontally)

This data is consumed by buildPortraitFilter() in server.js for
"subject-region" cropping — we fit the crop to show all subjects
with generous safe margins, instead of blindly filling portrait height.

Usage:
  python3.9 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
"""
import sys, json, os

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
    max_frames = max(10, min(int(clip_dur * sample_fps) + 2, 50))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    # Records per sampled frame: list of lists of dicts
    frame_faces    = []
    frames_sampled = 0

    if USE_MEDIAPIPE:
        mp_face  = mp.solutions.face_detection
        detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.50)

        while frames_sampled < max_frames:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if pos_ms / 1000.0 > end + 0.3:
                break
            ret, frame = cap.read()
            if not ret:
                break

            frames_sampled += 1
            rgb    = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = detector.process(rgb)

            frame_dets = []
            if result.detections:
                for det in result.detections:
                    score = det.score[0] if det.score else 0
                    bb    = det.location_data.relative_bounding_box
                    if score < 0.45 or bb.width < 0.025:
                        continue
                    x1 = max(0.0, min(1.0, bb.xmin))
                    y1 = max(0.0, min(1.0, bb.ymin))
                    x2 = max(0.0, min(1.0, bb.xmin + bb.width))
                    y2 = max(0.0, min(1.0, bb.ymin + bb.height))
                    frame_dets.append({
                        "cx": (x1 + x2) / 2.0,
                        "cy": (y1 + y2) / 2.0,
                        "x1": x1, "y1": y1,
                        "x2": x2, "y2": y2,
                        "w":  x2 - x1,
                        "h":  y2 - y1,
                    })

            frame_faces.append(frame_dets)
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

        while frames_sampled < max_frames:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if pos_ms / 1000.0 > end + 0.3:
                break
            ret, frame = cap.read()
            if not ret:
                break
            frames_sampled += 1

            h360 = max(1, int(360 * src_height / max(1, src_width)))
            small = cv2.resize(frame, (360, h360))
            gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            gray  = cv2.equalizeHist(gray)
            faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(18, 18))

            frame_dets = []
            sx = 1.0 / 360.0
            sy = 1.0 / max(1, h360)
            for (x, y, w, h) in faces:
                x1 = max(0.0, min(1.0, x * sx))
                y1 = max(0.0, min(1.0, y * sy))
                x2 = max(0.0, min(1.0, (x + w) * sx))
                y2 = max(0.0, min(1.0, (y + h) * sy))
                if (x2 - x1) < 0.025:
                    continue
                frame_dets.append({
                    "cx": (x1 + x2) / 2.0,
                    "cy": (y1 + y2) / 2.0,
                    "x1": x1, "y1": y1,
                    "x2": x2, "y2": y2,
                    "w":  x2 - x1,
                    "h":  y2 - y1,
                })
            frame_faces.append(frame_dets)

            for _ in range(interval - 1):
                r2, _ = cap.read()
                if not r2:
                    break

    cap.release()

    # ── Aggregate ────────────────────────────────────────────────────
    all_dets   = [d for frame in frame_faces for d in frame]
    # Max faces visible in any single frame
    face_count = max((len(f) for f in frame_faces if f), default=0)

    if not all_dets:
        # No faces found → conservative wide framing defaults
        print(json.dumps({
            "speakerSide":   "center",
            "meanFaceX":     0.5,
            "meanFaceY":     0.38,
            "meanFaceW":     0.0,
            "meanFaceH":     0.0,
            "faceCount":     0,
            "combinedBox":   {"x1": 0.15, "y1": 0.05, "x2": 0.85, "y2": 0.90},
            "srcWidth":      src_width,
            "srcHeight":     src_height,
            "framesSampled": frames_sampled,
            "totalDets":     0,
            "detector":      "mediapipe" if USE_MEDIAPIPE else "haar"
        }))
        return

    # Weighted averages (weight = face area → larger/closer face dominates)
    weights = [d["w"] * d["h"] for d in all_dets]
    total_w = sum(weights) or 1.0
    mean_cx = sum(d["cx"] * w for d, w in zip(all_dets, weights)) / total_w
    mean_cy = sum(d["cy"] * w for d, w in zip(all_dets, weights)) / total_w
    mean_fw = sum(d["w"]  * w for d, w in zip(all_dets, weights)) / total_w
    mean_fh = sum(d["h"]  * w for d, w in zip(all_dets, weights)) / total_w

    # Combined bounding box = union of all detections across all frames
    cb_x1 = max(0.0, min(d["x1"] for d in all_dets))
    cb_y1 = max(0.0, min(d["y1"] for d in all_dets))
    cb_x2 = min(1.0, max(d["x2"] for d in all_dets))
    cb_y2 = min(1.0, max(d["y2"] for d in all_dets))

    # Horizontal movement range (10th–90th percentile of face centers)
    sorted_cx = sorted(d["cx"] for d in all_dets)
    n = len(sorted_cx)
    lo_idx = max(0, int(n * 0.10))
    hi_idx = min(n - 1, int(n * 0.90))
    range_cx = sorted_cx[hi_idx] - sorted_cx[lo_idx] if n > 2 else 0.0

    speaker_side = "center"
    if mean_cx < 0.38:
        speaker_side = "left"
    elif mean_cx > 0.62:
        speaker_side = "right"

    print(json.dumps({
        "speakerSide":   speaker_side,
        "meanFaceX":     round(mean_cx, 4),
        "meanFaceY":     round(mean_cy, 4),
        "meanFaceW":     round(mean_fw, 4),
        "meanFaceH":     round(mean_fh, 4),
        "faceCount":     face_count,
        "rangeCX":       round(range_cx, 4),
        "combinedBox": {
            "x1": round(cb_x1, 4),
            "y1": round(cb_y1, 4),
            "x2": round(cb_x2, 4),
            "y2": round(cb_y2, 4)
        },
        "totalDets":     len(all_dets),
        "srcWidth":      src_width,
        "srcHeight":     src_height,
        "framesSampled": frames_sampled,
        "detector":      "mediapipe" if USE_MEDIAPIPE else "haar"
    }))

if __name__ == "__main__":
    main()
