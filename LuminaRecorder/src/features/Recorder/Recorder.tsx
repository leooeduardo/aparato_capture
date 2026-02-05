import { useRef, useState, useEffect } from 'react';
import { useElementSize } from '../../hooks/useElementSize';
import { WarpCanvas } from '../WarpEditor/WarpCanvas';
import type { WarpState } from '../../App';
import { useWarpBroadcast } from '../../hooks/useWarpBroadcast';
import { useVideoProcessor } from '../../hooks/useVideoProcessor';
import { Video, FileVideo } from 'lucide-react';

interface RecorderProps {
    onNext: () => void;
    onBack: () => void;
    videoSource: string | null;
    warpState: WarpState;
    setRecordedBlobUrl: (url: string) => void;
    setRecordedFormat: (fmt: 'webm' | 'mp4') => void;
}

export function Recorder({ onNext, onBack, videoSource, warpState, setRecordedBlobUrl, setRecordedFormat }: RecorderProps) {
    const { ref: containerRef, element: containerElement, width, height } = useElementSize();
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [recordingKey, setRecordingKey] = useState(0);

    const processingRef = useRef(false);
    const durationRef = useRef(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]); // Ref to track chunks without closure staleness
    const { sendMessage } = useWarpBroadcast();
    const { convertToMp4, progress: conversionProgress } = useVideoProcessor();

    // 100-byte bug fix: Ensure chunks are collected properly
    const handleDataAvailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
            console.log('[Recorder] Chunk received:', event.data.size);
            chunksRef.current.push(event.data);
        }
    };

    const handleStartRecording = async () => {
        console.log('[Recorder] Start Requested');
        processingRef.current = false;
        const canvas = containerElement?.querySelector('canvas');
        if (!canvas || !videoSource) {
            console.error('[Recorder] No canvas or video source', { canvas: !!canvas, videoSource });
            return;
        }

        chunksRef.current = [];

        // Get Duration reliably
        const tempVideo = document.createElement('video');
        tempVideo.src = videoSource;
        await new Promise((resolve) => {
            tempVideo.onloadedmetadata = () => resolve(true);
        });
        const dur = tempVideo.duration;
        console.log('[Recorder] Video Duration:', dur);

        if (!dur || !isFinite(dur)) {
            alert("Could not determine video duration. Please try again.");
            return;
        }

        durationRef.current = dur;

        // Start Recorder
        const stream = canvas.captureStream(60); // 60 FPS
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm';

        console.log('[Recorder] MimeType:', mimeType);

        const mediaRecorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 25000000 // 25 Mbps High Quality
        });

        mediaRecorder.ondataavailable = handleDataAvailable;
        mediaRecorder.onerror = (e) => console.error('[Recorder] Error:', e);
        mediaRecorder.onstop = () => {
            console.log('[Recorder] Stopped. Chunks:', chunksRef.current.length);
            setIsRecording(false);
            setIsProcessing(true); // Start processing phase
        };

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(100); // Collect chunks every 100ms
        setIsRecording(true);
        setRecordingKey(prev => prev + 1); // Restart video

        console.log('[Recorder] Recording Started');

        // Stop after duration
        setTimeout(() => {
            console.log('[Recorder] Stopping...');
            if (mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
            }
        }, dur * 1000); // Exact duration, no padding
    };

    // Process to MP4 after recording stops
    useEffect(() => {
        const processVideo = async () => {
            if (isProcessing && chunksRef.current.length > 0 && !processingRef.current) {
                processingRef.current = true;
                console.log('[Recorder] Processing Started. Chunks:', chunksRef.current.length);
                const webmBlob = new Blob(chunksRef.current, { type: 'video/webm' });

                // Convert to MP4
                try {
                    console.log('[Recorder] Calling convertToMp4...');
                    const mp4Blob = await convertToMp4(webmBlob, durationRef.current);
                    if (mp4Blob) {
                        const url = URL.createObjectURL(mp4Blob);
                        setRecordedBlobUrl(url);
                        setRecordedFormat('mp4');

                        // Auto-Close Output Window
                        sendMessage({ type: 'CLOSE_WINDOW' });

                        // Auto-Advance to Save
                        onNext();
                    }
                } catch (e) {
                    console.error("MP4 Conversion Failed", e);
                    // alert("MP4 conversion failed. Falling back to WebM."); // Remove alert for smoother UX
                    const url = URL.createObjectURL(webmBlob);
                    setRecordedBlobUrl(url);
                    setRecordedFormat('webm');
                    sendMessage({ type: 'CLOSE_WINDOW' }); // Close on fallback too
                    onNext();
                } finally {
                    setIsProcessing(false);
                }
            }
        };

        if (isProcessing) {
            processVideo();
        }
    }, [isProcessing, convertToMp4, setRecordedBlobUrl, onNext, sendMessage, setRecordedFormat]);

    return (
        <div className="flex h-full flex-col bg-background">
            <div className="flex items-center justify-between px-8 py-4 bg-surface border-b border-surface/50 shadow-md">
                <h2 className="text-slate-200 font-medium flex items-center gap-2">
                    <Video className="w-5 h-5 text-primary" />
                    Recording Output
                </h2>
                <div className="flex gap-4">
                    <button onClick={onBack} disabled={isRecording || isProcessing} className="text-slate-400 hover:text-white disabled:opacity-50 transition-colors font-medium">Back</button>
                </div>
            </div>

            <div className="flex-1 bg-black/50 relative flex items-center justify-center p-8 flex-col gap-8">
                {/* 
                    Hidden Canvas Container: 
                    We keep it mounted but visually hidden (using opacity/z-index instead of display:none to ensure rendering continues) 
                    when showing the progress UI.
                */}
                {/* Progress UI: Shown during recording/processing - Overlays the Canvas */}
                {(isRecording || isProcessing) && (
                    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center p-12 bg-black backdrop-blur-sm border border-slate-700/50 rounded-lg animate-in fade-in duration-300">
                        <div className="relative mb-6">
                            <div className="w-24 h-24 rounded-full border-4 border-slate-700" />
                            <div className="absolute inset-0 w-24 h-24 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                            <FileVideo className="absolute inset-0 w-10 h-10 text-primary m-auto animate-pulse" />
                        </div>

                        <h3 className="text-2xl font-bold text-white mb-2">
                            {isRecording ? "Recording in progress..." : "Converting to MP4..."}
                        </h3>

                        <p className="text-slate-400 text-center max-w-sm mb-6">
                            {isRecording
                                ? "We are capturing the distorted output properly. Please wait."
                                : `Optimizing video for portability. Progress: ${conversionProgress}%`}
                        </p>

                        {!isRecording && isProcessing && (
                            <div className="w-64 h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary transition-all duration-300 ease-out"
                                    style={{ width: `${conversionProgress}%` }}
                                />
                            </div>
                        )}
                    </div>
                )}

                <div
                    ref={containerRef}
                    className="relative w-full max-w-5xl aspect-video"
                    style={{
                        // opacity: isRecording || isProcessing ? 0 : 1, // DO NOT HIDE -> Breaks Capture
                        // position: isRecording || isProcessing ? 'absolute' : 'relative',
                        pointerEvents: 'none'
                    }}
                >
                    <div className="w-full h-full shadow-2xl border border-slate-800 bg-black rounded-lg overflow-hidden">
                        <WarpCanvas
                            recordingTrigger={recordingKey}
                            videoSource={videoSource}
                            grid={warpState.grid}
                            rows={warpState.rows}
                            cols={warpState.cols}
                            width={Math.floor(width / 2) * 2}
                            height={Math.floor(height / 2) * 2}
                        />
                    </div>
                </div>

                {/* Controls: Only shown when NOT recording/processing */}
                {!isRecording && !isProcessing && (
                    <div className="flex flex-col items-center gap-4 z-10">
                        <button
                            onClick={handleStartRecording}
                            className="group flex items-center gap-3 px-8 py-4 bg-red-600 hover:bg-red-500 text-white rounded-full font-bold text-lg shadow-xl shadow-red-900/20 hover:scale-105 transition-all"
                        >
                            <div className="w-4 h-4 bg-white rounded-full group-hover:scale-125 transition-transform" />
                            Start Processing & Record
                        </button>
                        <p className="text-slate-500 text-sm">
                            Click to verify preview, then record.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
