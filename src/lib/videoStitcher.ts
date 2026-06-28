import fixWebmDuration from 'fix-webm-duration';

function pickMimeType(): string {
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

function mediaEvent(el: HTMLMediaElement, name: string): Promise<void> {
    return new Promise((resolve) => el.addEventListener(name, () => resolve(), { once: true }));
}

/**
 * Join recorded WebM segments into ONE valid WebM by replaying them through a
 * canvas + MediaRecorder — i.e. the browser's native encoder.
 *
 * Why not ffmpeg.wasm: Chrome records the canvas as VP9 with an alpha plane
 * (`alpha_mode: 1`), and ffmpeg.wasm crashes ("memory access out of bounds")
 * trying to re-encode that. Re-recording through the same native pipeline that
 * already produces the segments sidesteps the whole problem. It runs in real
 * time (about as long as the combined recording).
 */
export async function stitchSegments(
    blobs: Blob[],
    onProgress?: (fraction: number) => void
): Promise<Blob> {
    if (blobs.length <= 1) return blobs[0];

    // Probe the first segment for the output frame size.
    const probe = document.createElement('video');
    probe.src = URL.createObjectURL(blobs[0]);
    probe.muted = true;
    await mediaEvent(probe, 'loadedmetadata');
    const width = probe.videoWidth || 1280;
    const height = probe.videoHeight || 720;
    URL.revokeObjectURL(probe.src);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // alpha: false → opaque output (the source segments fully cover the frame).
    const ctx = canvas.getContext('2d', { alpha: false })!;

    const audioCtx = new AudioContext();
    await audioCtx.resume().catch(() => {});
    const dest = audioCtx.createMediaStreamDestination();

    const stream = canvas.captureStream(0);
    const frameTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const recorder = new MediaRecorder(stream, {
        mimeType: pickMimeType(),
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    const startMs = Date.now();
    recorder.start(500);

    for (let i = 0; i < blobs.length; i++) {
        await playSegment(blobs[i], ctx, width, height, frameTrack, audioCtx, dest, (f) =>
            onProgress?.((i + f) / blobs.length)
        );
    }

    await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
    });
    const durationMs = Date.now() - startMs;
    audioCtx.close();
    frameTrack.stop();

    const raw = new Blob(chunks, { type: 'video/webm' });
    return fixWebmDuration(raw, durationMs);
}

async function playSegment(
    blob: Blob,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frameTrack: CanvasCaptureMediaStreamTrack,
    audioCtx: AudioContext,
    dest: MediaStreamAudioDestinationNode,
    onProgress: (fraction: number) => void
): Promise<void> {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    video.playsInline = true;
    await mediaEvent(video, 'loadedmetadata');

    // Route the segment's audio into the shared destination. createMediaElementSource
    // reroutes the element's audio entirely into the graph (and we never connect it
    // to the speakers), so nothing is audible while stitching runs.
    let srcNode: MediaElementAudioSourceNode | null = null;
    try {
        srcNode = audioCtx.createMediaElementSource(video);
        srcNode.connect(dest);
    } catch {
        /* segment has no audio track */
    }

    await video.play();

    await new Promise<void>((resolve) => {
        const id = setInterval(() => {
            if (video.readyState >= 2) {
                ctx.drawImage(video, 0, 0, width, height);
                frameTrack.requestFrame();
                if (video.duration) onProgress(Math.min(1, video.currentTime / video.duration));
            }
        }, 1000 / 30);
        video.onended = () => {
            clearInterval(id);
            resolve();
        };
    });

    srcNode?.disconnect();
    video.pause();
    URL.revokeObjectURL(video.src);
}
