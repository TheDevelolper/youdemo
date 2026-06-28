import { convertVideo } from './ffmpegConverter.js';
import type { ExportOptions } from './ffmpegConverter.js';

self.onmessage = async (e: MessageEvent<ExportOptions>) => {
    try {
        const blob = await convertVideo(e.data);
        self.postMessage({ type: 'complete', blob });
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
    }
};
