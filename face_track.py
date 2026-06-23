#!/usr/bin/env python3
"""
Face tracking script for ClipForge AI rendering pipeline.
Usage: python3 face_track.py <video_path> <start_sec> <end_sec> <sample_fps>
Output: JSON with face positions per sampled frame
"""
import sys
import json

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: face_track.py <video> <start> <end> [sample_fps]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    start      = float(sys.argv[2])
    end        = float(sys.argv[3])
    sample_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

    try:
        import cv2
        has_cv2 = True
    except ImportError:
        has_cv2 = False

    try:
        import mediapipe as mp
        has_mp = True
    except ImportError:
        has_mp = False

    if not has_cv2 or not has_mp:
        print(json.dumps({"error": "mediapipe or opencv not available", "speakerSide": "center", "faces": []}))
        sys.exit(0)

    mp_face = mp.solutions.face_detection
    frames  = []

    cap = cv2.VideoCapture(video_path)
    src_fps   = cap.get(cv2.CAP_PROP_FPS) or 30
    src_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    interval  = max(1, int(src_fps / sample_fps))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.5) as detector:
        while True:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if pos_ms / 1000 > end + 0.1:
                break
            ret, frame = cap.read()
            if not ret:
                break

            current_sec = pos_ms / 1000
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = detector.process(rgb)

            face_data = []
            if result.detections:
                for det in result.detections:
                    bb = det.location_data.relative_bounding_box
                    cx = (bb.xmin + bb.width / 2)   # 0..1
                    cy = (bb.ymin + bb.height / 2)   # 0..1
                    face_data.append({
                        "cx": round(cx, 3),
                        "cy": round(cy, 3),
                        "w":  round(bb.width, 3),
                        "h":  round(bb.height, 3),
                        "score": round(det.score[0] if det.score else 0, 3)
                    })

            frames.append({
                "t": round(current_sec - start, 3),
                "faces": face_data
            })

            # Skip to next sample frame
            for _ in range(interval - 1):
                cap.read()

    cap.release()

    # Compute aggregate speaker side from face center-x positions
    all_cx = [f["cx"] for fr in frames for f in fr["faces"]]
    if all_cx:
        mean_cx = sum(all_cx) / len(all_cx)
        if mean_cx < 0.38:
            speaker_side = "left"
        elif mean_cx > 0.62:
            speaker_side = "right"
        else:
            speaker_side = "center"
    else:
        speaker_side = "center"

    # Compute dominant face zone (for crop offset)
    dominant_y = sum(f["cy"] for fr in frames for f in fr["faces"]) / max(1, len(all_cx))

    print(json.dumps({
        "speakerSide": speaker_side,
        "meanFaceX": round(sum(all_cx) / max(1, len(all_cx)), 3) if all_cx else 0.5,
        "meanFaceY": round(dominant_y, 3),
        "srcWidth": src_width,
        "srcHeight": src_height,
        "totalFaceDetections": len(all_cx),
        "frames": frames[:5]  # send first 5 frames for debugging
    }))

if __name__ == "__main__":
    main()
