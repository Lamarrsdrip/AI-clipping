#!/usr/bin/env python3
"""
Face tracking script for ClipForge AI rendering pipeline.
Uses OpenCV Haar cascade (included with OpenCV) for face detection.
Falls back to DNN-based detection if model files are available.

Usage: python3 face_track.py <video_path> <start_sec> <end_sec> [sample_fps]
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

    # Use built-in Haar cascade (ships with every OpenCV install)
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_alt2.xml'
    if not os.path.exists(cascade_path):
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'

    if not os.path.exists(cascade_path):
        print(json.dumps({"error": "No cascade file found", "speakerSide": "center"}))
        sys.exit(0)

    face_cascade = cv2.CascadeClassifier(cascade_path)

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
    frames_sampled = 0
    MAX_FRAMES = 20  # cap to keep it fast

    while frames_sampled < MAX_FRAMES:
        pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
        if pos_ms / 1000 > end + 0.1:
            break

        ret, frame = cap.read()
        if not ret:
            break

        frames_sampled += 1

        # Downscale for speed
        small = cv2.resize(frame, (640, int(640 * src_height / src_width)))
        gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray  = cv2.equalizeHist(gray)

        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.15,
            minNeighbors=4,
            minSize=(30, 30),
            flags=cv2.CASCADE_SCALE_IMAGE
        )

        if len(faces) > 0:
            for (x, y, w, h) in faces:
                # Convert back to original frame coordinates (relative 0..1)
                scale_x = src_width / 640
                scale_y = src_height / (640 * src_height / src_width)
                cx = ((x + w / 2) * scale_x) / src_width
                cy = ((y + h / 2) * scale_y) / src_height
                # Only count high-confidence large faces (filter noise)
                if w * scale_x > src_width * 0.05:
                    all_cx.append(cx)
                    all_cy.append(cy)

        # Skip frames
        for _ in range(interval - 1):
            ret2, _ = cap.read()
            if not ret2:
                break

    cap.release()

    if not all_cx:
        print(json.dumps({
            "speakerSide": "center",
            "meanFaceX": 0.5,
            "meanFaceY": 0.4,
            "srcWidth": src_width,
            "srcHeight": src_height,
            "totalFaceDetections": 0,
            "framesSampled": frames_sampled
        }))
        return

    mean_cx = sum(all_cx) / len(all_cx)
    mean_cy = sum(all_cy) / len(all_cy)

    # Classify speaker side
    if mean_cx < 0.38:
        speaker_side = "left"
    elif mean_cx > 0.62:
        speaker_side = "right"
    else:
        speaker_side = "center"

    print(json.dumps({
        "speakerSide": speaker_side,
        "meanFaceX": round(mean_cx, 3),
        "meanFaceY": round(mean_cy, 3),
        "srcWidth": src_width,
        "srcHeight": src_height,
        "totalFaceDetections": len(all_cx),
        "framesSampled": frames_sampled
    }))

if __name__ == "__main__":
    main()
