#!/usr/bin/env /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
"""
Face tracking script for ClipForge AI rendering pipeline.
Uses MediaPipe BlazeFace (neural face detector) for accurate face positions.
Falls back to OpenCV Haar cascade if MediaPipe is unavailable.

Usage: python3.9 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
Output: JSON with speaker side and aggregate face position
"""
import sys
import json
import os

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: face_track.py <video> <start> <end> [sample_fps]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    start      = float(sys.argv[2])
    end        = float(sys.argv[3])
    sample_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 3.0

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

    src_fps    = cap.get(cv2.CAP_PROP_FPS) or 30
    src_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    interval   = max(1, int(src_fps / sample_fps))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    all_cx = []
    all_cy = []
    all_sizes = []
    frames_sampled = 0
    MAX_FRAMES = 25

    if USE_MEDIAPIPE:
        # BlazeFace: neural face detector, accurate & fast
        mp_face = mp.solutions.face_detection
        detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.55)

        while frames_sampled < MAX_FRAMES:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if pos_ms / 1000 > end + 0.1:
                break

            ret, frame = cap.read()
            if not ret:
                break

            frames_sampled += 1
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = detector.process(rgb)

            if result.detections:
                for det in result.detections:
                    bb = det.location_data.relative_bounding_box
                    cx = bb.xmin + bb.width / 2
                    cy = bb.ymin + bb.height / 2
                    area = bb.width * bb.height
                    # Filter out tiny spurious detections
                    if bb.width > 0.04 and det.score[0] > 0.55:
                        all_cx.append(max(0, min(1, cx)))
                        all_cy.append(max(0, min(1, cy)))
                        all_sizes.append(area)

            for _ in range(interval - 1):
                ret2, _ = cap.read()
                if not ret2:
                    break

        detector.close()

    else:
        # Fallback: OpenCV Haar cascade
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_alt2.xml'
        if not os.path.exists(cascade_path):
            cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        face_cascade = cv2.CascadeClassifier(cascade_path)

        while frames_sampled < MAX_FRAMES:
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if pos_ms / 1000 > end + 0.1:
                break
            ret, frame = cap.read()
            if not ret:
                break
            frames_sampled += 1

            small = cv2.resize(frame, (640, int(640 * src_height / max(1, src_width))))
            gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            gray  = cv2.equalizeHist(gray)
            faces = face_cascade.detectMultiScale(gray, 1.15, 4, minSize=(30, 30))

            if len(faces) > 0:
                scale_x = src_width / 640
                scale_y = src_height / (640 * src_height / max(1, src_width))
                for (x, y, w, h) in faces:
                    cx = ((x + w / 2) * scale_x) / src_width
                    cy = ((y + h / 2) * scale_y) / src_height
                    if w * scale_x > src_width * 0.04:
                        all_cx.append(cx)
                        all_cy.append(cy)
                        all_sizes.append((w / 640) * (h / 480))

            for _ in range(interval - 1):
                ret2, _ = cap.read()
                if not ret2:
                    break

    cap.release()

    if not all_cx:
        print(json.dumps({
            "speakerSide": "center",
            "meanFaceX": 0.5,
            "meanFaceY": 0.38,
            "srcWidth": src_width,
            "srcHeight": src_height,
            "totalFaceDetections": 0,
            "framesSampled": frames_sampled,
            "detector": "mediapipe" if USE_MEDIAPIPE else "haar"
        }))
        return

    # Weight by face size — larger (closer) face = dominant speaker
    total_w = sum(all_sizes) or 1
    mean_cx = sum(cx * sz for cx, sz in zip(all_cx, all_sizes)) / total_w
    mean_cy = sum(cy * sz for cy, sz in zip(all_cy, all_sizes)) / total_w

    if mean_cx < 0.38:
        speaker_side = "left"
    elif mean_cx > 0.62:
        speaker_side = "right"
    else:
        speaker_side = "center"

    print(json.dumps({
        "speakerSide": speaker_side,
        "meanFaceX": round(mean_cx, 4),
        "meanFaceY": round(mean_cy, 4),
        "srcWidth": src_width,
        "srcHeight": src_height,
        "totalFaceDetections": len(all_cx),
        "framesSampled": frames_sampled,
        "detector": "mediapipe" if USE_MEDIAPIPE else "haar"
    }))

if __name__ == "__main__":
    main()
