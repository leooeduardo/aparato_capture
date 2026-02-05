import { useRef, useState, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export function useVideoProcessor() {
    const ffmpegRef = useRef(new FFmpeg());
    const [loaded, setLoaded] = useState(false);
    const [progress, setProgress] = useState(0);

    const load = async () => {
        const ffmpeg = ffmpegRef.current;

        // Attach logger immediately to debug loading
        ffmpeg.on('log', ({ message }) => {
            console.log('[FFmpeg Load]', message);
        });

        const isDev = import.meta.env.DEV;
        const isElectron = window.navigator.userAgent.toLowerCase().includes('electron');

        // Use absolute path for dev (served from public) and relative for prod (Electron file://)
        const baseURL = (isDev && !isElectron) ? '/ffmpeg-core' : './ffmpeg-core';

        console.log('[FFmpeg] Loading from:', baseURL, '(isDev:', isDev, 'isElectron:', isElectron, ')');

        try {
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            });
            console.log('[FFmpeg] Load Success');
            setLoaded(true);
        } catch (error) {
            console.error('[FFmpeg] Load Failed:', error);
            throw error;
        }
    };

    const convertToMp4 = useCallback(async (webmBlob: Blob, duration: number): Promise<Blob | null> => {
        const ffmpeg = ffmpegRef.current;

        // Ensure logs are attached (idempotent usually, or safe to re-attach)
        if (!loaded) await load();

        await ffmpeg.writeFile('input.webm', await fetchFile(webmBlob));

        ffmpeg.on('progress', ({ time }) => {
            console.log('[Recorder] Progress Event:', time, 'Duration:', duration);
            if (duration > 0 && time > 0) {
                // @ffmpeg/core 0.12 sends time in MICROSECONDS (us)
                // duration is in SECONDS (s)
                const timeInSeconds = time / 1000000;
                const p = Math.min(100, Math.max(0, (timeInSeconds / duration) * 100));
                setProgress(Math.round(p));
            }
        });

        // ... rest of exec

        // Transcode to MP4 (High Quality)
        const args = [
            '-i', 'input.webm',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'ultrafast',
            '-crf', '22',
            '-max_muxing_queue_size', '1024',
            'output.mp4'
        ];

        console.log('[Recorder] FFmpeg Command:', args);

        await ffmpeg.exec(args);

        const data = await ffmpeg.readFile('output.mp4');
        return new Blob([data as any], { type: 'video/mp4' });
    }, [loaded]);

    return { convertToMp4, progress, loaded };
}
