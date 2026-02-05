import { useState, useEffect, useRef, useCallback } from 'react'
import { ThreeRenderer } from './core/ThreeRenderer'
import { useLedBridge } from './hooks/useLedBridge'
import { TEST_VIDEOS } from './constants/videos';
import { Play, Pause, Grid3X3, MousePointer2, ExternalLink, RotateCcw, Plus, Minus, ChevronDown, Settings } from 'lucide-react'
import { io } from 'socket.io-client';
import FirmwareUpload from './components/FirmwareUpload';
import { TestPatterns } from './components/TestPatterns';




// Types
interface Point { x: number; y: number }
interface Crop { x: number, y: number, width: number, height: number }
interface EdgeBlendConfig { left: number; right: number; top: number; bottom: number; gamma: number; }
interface ProjectorConfig {
    grid: Point[][]; // [rows][cols]
    rows: number;
    cols: number;
    crop: Crop;
    edgeBlend: EdgeBlendConfig;
    mode: 'linear' | 'bicubic'; // visualization/interaction mode: linear=Quad (2x2), bicubic=Bezier (Handles)
    flipH?: boolean;
    flipV?: boolean;
    masks?: { id: string; points: Point[] }[];
}

// Helper: Equidistant Grid
const createDefaultGrid = (rows: number, cols: number, width = 360, height = 202): Point[][] => {
    const grid: Point[][] = [];
    for (let r = 0; r < rows; r++) {
        const row: Point[] = [];
        for (let c = 0; c < cols; c++) {
            row.push({
                x: (c / (cols - 1)) * width,
                y: (r / (rows - 1)) * height
            });
        }
        grid.push(row);
    }
    return grid;
};

import { WarpMath } from './core/WarpMath';

// Resample grid to new resolution while preserving shape
const resampleGrid = (
    oldGrid: Point[][],
    oldRows: number,
    oldCols: number,
    newRows: number,
    newCols: number,
    mode: 'linear' | 'bicubic'
): Point[][] => {
    const newGrid: Point[][] = [];
    for (let r = 0; r < newRows; r++) {
        const row: Point[] = [];
        for (let c = 0; c < newCols; c++) {
            const u = c / (newCols - 1);
            const v = r / (newRows - 1);

            // Interpolate from old grid
            const pt = WarpMath.interpolate(u, v, oldGrid, oldCols, oldRows, mode);
            row.push(pt);
        }
        newGrid.push(row);
    }
    return newGrid;
};

// Auto-calculate internal points (P11, P12, P21, P22) for a 4x4 grid using Linear Coons Patch approximation
// to ensure the surface follows the Bezier edges smoothly without manual internal controls.
const calculateInternalPoints = (grid: Point[][]): Point[][] => {
    if (grid.length !== 4 || grid[0].length !== 4) return grid;

    // Indices
    // 00 01 02 03
    // 10 11 12 13
    // 20 21 22 23
    // 30 31 32 33

    const newGrid = grid.map(row => row.map(p => ({ ...p })));

    // We need to solve for 11, 12, 21, 22 based on the boundary.
    // Simple approach: Bilinear interpolation of the opposing boundaries.

    for (let i = 1; i <= 2; i++) {
        for (let j = 1; j <= 2; j++) {
            const u = j / 3;
            const v = i / 3;

            // Ruled surface approximations
            // L_c(u, v) = (1-v)*P(u, 0) + v*P(u, 1)  <-- Vertical linear interpolation between Top and Bottom Curves
            // But P(u,0) is point on top curve. We don't have the curve function, just control points.
            // Actually, for 4x4 Bezier, the inner points *define* the surface.
            // To make it "well behaved" like a Coons patch, we can interpolate.

            // Simplest heuristic: Average of horizontal and vertical linear interpolations of control points
            const left = newGrid[i][0];
            const right = newGrid[i][3];
            const top = newGrid[0][j];
            const bottom = newGrid[3][j];

            // Linearly interpolate row i
            const lx = left.x + (right.x - left.x) * (j / 3);
            const ly = left.y + (right.y - left.y) * (j / 3);

            // Linearly interpolate col j
            const cx = top.x + (bottom.x - top.x) * (i / 3);
            const cy = top.y + (bottom.y - top.y) * (i / 3);

            newGrid[i][j].x = (lx + cx) / 2;
            newGrid[i][j].y = (ly + cy) / 2;
        }
    }
    return newGrid;
};

// Default Config
// Default Config
const DEFAULT_CONFIGS = (): ProjectorConfig[] => [0, 1, 2].map(i => ({
    rows: 2,
    cols: 2,
    grid: createDefaultGrid(2, 2),
    mode: 'linear', // Default to Quad
    crop: {
        x: i * (1 / 3),
        y: 0,
        width: 1 / 3,
        height: 1
    },
    edgeBlend: { left: 0, right: 0, top: 0, bottom: 0, gamma: 1.0 }
}));

// PROJECT MEDIA: Add your local files here (place them in public/videos/)
const LOCAL_VIDEOS: { title: string; filename: string }[] = [
    { title: 'Idle Loop', filename: 'idle_loop.mp4' },
    { title: 'Main Content', filename: 'main_content.mp4' },
];

const OutputWindow = ({ index }: { index: number }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasWrapperRef = useRef<HTMLDivElement>(null);
    // Dual Video Refs for Output
    const idleVideoRef = useRef<HTMLVideoElement>(null);
    const mainVideoRef = useRef<HTMLVideoElement>(null);

    const rendererRef = useRef<ThreeRenderer | null>(null);
    const [config, setConfig] = useState<ProjectorConfig | null>(null);
    const [isFs, setIsFs] = useState(false);
    const [aspectLock, setAspectLock] = useState(false);

    // Initial Setup
    useEffect(() => {
        const onFs = () => setIsFs(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFs);
        if (!canvasWrapperRef.current) return;

        // Hide cursor setup
        let timeout: any;
        const onMove = () => {
            document.body.style.cursor = 'default';
            clearTimeout(timeout);
            timeout = setTimeout(() => document.body.style.cursor = 'none', 3000);
        };
        window.addEventListener('mousemove', onMove);

        // Shortcuts 'F' and 'A'
        const onKey = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            if (k === 'f') {
                if (!document.fullscreenElement) {
                    containerRef.current?.requestFullscreen().catch(e => console.error(e));
                } else {
                    document.exitFullscreen().catch(e => console.error(e));
                }
            }
            if (k === 'a') {
                e.preventDefault();
                setAspectLock(prev => !prev);
            }
        };
        window.addEventListener('keydown', onKey);

        // Init Renderer targetting wrapper
        const r = new ThreeRenderer([{ index, container: canvasWrapperRef.current }]);
        rendererRef.current = r;

        // Sync Function for Config
        const syncConfig = () => {
            const str = localStorage.getItem('lumina-config-v4');
            if (str) {
                try {
                    const configs: ProjectorConfig[] = JSON.parse(str);
                    const conf = configs[index];
                    if (conf) {
                        setConfig(conf);
                        r.updateInputCrop(index, conf.crop);
                        r.updateGridWarp(index, conf.grid, conf.rows, conf.cols, conf.mode);
                        if (conf.edgeBlend) r.updateEdgeBlend(index, conf.edgeBlend);
                    }
                } catch (e) { console.error('Config parse error', e); }
            }
        };

        syncConfig();
        window.addEventListener('storage', syncConfig);

        return () => {
            r.dispose();
            rendererRef.current = null;
            window.removeEventListener('storage', syncConfig);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('fullscreenchange', onFs);
        }
    }, [index]);

    // Handle Resize keep warp correct
    useEffect(() => {
        const handleResize = () => {
            if (rendererRef.current && canvasWrapperRef.current) {
                // Resize Renderer to match Wrapper (which is 100% of window or aspect locked container)
                const w = canvasWrapperRef.current.clientWidth;
                const h = canvasWrapperRef.current.clientHeight;
                if (w > 0 && h > 0) {
                    rendererRef.current.resize(index, w, h);
                }
            }
        };
        // Use a small delay to ensure DOM has updated styles for aspectratio
        const timeout = setTimeout(handleResize, 50);
        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(timeout);
        };
    }, [index, aspectLock]);

    // Sync Slave (Updated for Dual Video)
    useEffect(() => {
        const channel = new BroadcastChannel('lumina_sync');
        channel.postMessage({ type: 'HELLO' });
        channel.onmessage = (e) => {
            if (e.data.type === 'SYNC') {
                const { idleSrc, mainSrc, idleTime, mainTime, idlePaused, mainPaused, mix, syncProjectors } = e.data;

                // Sync Videos
                if (idleVideoRef.current) {
                    const v = idleVideoRef.current;
                    if (idleSrc && v.src !== new URL(idleSrc, window.location.href).href) v.src = idleSrc;
                    if (Math.abs(v.currentTime - idleTime) > 0.3) v.currentTime = idleTime;
                    if (idlePaused && !v.paused) v.pause();
                    if (!idlePaused && v.paused) v.play().catch(() => { });
                }

                if (mainVideoRef.current) {
                    const v = mainVideoRef.current;
                    if (mainSrc && v.src !== new URL(mainSrc, window.location.href).href) v.src = mainSrc;
                    if (Math.abs(v.currentTime - mainTime) > 0.3) v.currentTime = mainTime;
                    if (mainPaused && !v.paused) v.pause();
                    if (!mainPaused && v.paused) v.play().catch(() => { });
                }

                // Sync Mix & Config (Blending/Warp/Crop)
                if (rendererRef.current) {
                    rendererRef.current.setCrossfade(mix);

                    if (syncProjectors && syncProjectors[index]) {
                        const conf = syncProjectors[index];
                        setConfig(conf);
                        rendererRef.current.updateInputCrop(index, conf.crop);
                        rendererRef.current.updateGridWarp(index, conf.grid, conf.rows, conf.cols, conf.mode);
                        if (conf.edgeBlend) rendererRef.current.updateEdgeBlend(index, conf.edgeBlend);
                    }
                }
            }
        };
        return () => channel.close();
    }, []);

    // Ensure Renderer has video references
    // Ensure Renderer has video references
    useEffect(() => {
        if (!rendererRef.current) return;

        const updateVideos = () => {
            if (rendererRef.current && idleVideoRef.current && mainVideoRef.current) {
                rendererRef.current.setVideos(idleVideoRef.current, mainVideoRef.current);
            }
        };

        // Initial call
        updateVideos();

        const idle = idleVideoRef.current;
        const main = mainVideoRef.current;
        if (idle) idle.addEventListener('canplay', updateVideos);
        if (main) main.addEventListener('canplay', updateVideos);

        return () => {
            if (idle) idle.removeEventListener('canplay', updateVideos);
            if (main) main.removeEventListener('canplay', updateVideos);
        }
    }, [rendererRef.current]); // Re-run if renderer is recreated

    return (
        <div
            ref={containerRef}
            className="fixed inset-0 bg-black overflow-hidden cursor-default z-[9999] flex items-center justify-center"
            onClick={() => {
                if (!document.fullscreenElement) {
                    containerRef.current?.requestFullscreen().catch(e => console.error(e));
                }
            }}
        >
            <div
                ref={canvasWrapperRef}
                style={{
                    ...(aspectLock ? {
                        width: '100%',
                        height: '100%',
                        maxWidth: '177.78vh',
                        maxHeight: '56.25vw',
                        aspectRatio: '16/9',
                        position: 'relative'
                    } : {
                        width: '100%',
                        height: '100%',
                        position: 'absolute',
                        inset: 0
                    }),
                    transform: config ? `scale(${config.flipH ? -1 : 1}, ${config.flipV ? -1 : 1})` : 'none'
                }}
            />

            {/* Hidden Video Elements for Output */}
            <video
                ref={idleVideoRef}
                crossOrigin="anonymous" loop muted playsInline
                onError={(e) => console.error('Output Idle Error:', e.currentTarget.error)}
                onLoadedMetadata={() => console.log('Output Idle Loaded')}
                style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0.01, pointerEvents: 'none' }}
            />
            <video
                ref={mainVideoRef}
                crossOrigin="anonymous" muted playsInline
                onError={(e) => console.error('Output Main Error:', e.currentTarget.error)}
                onLoadedMetadata={() => console.log('Output Main Loaded')}
                style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0.01, pointerEvents: 'none' }}
            />

            <div className="absolute top-4 left-4 text-white/50 text-xs font-mono opacity-50 select-none z-50 pointer-events-none mix-blend-difference">
                OUTPUT {index + 1} {aspectLock && '[16:9 LOCKED]'}
            </div>



            {!isFs && (
                <button

                    onClick={(e) => {
                        e.stopPropagation();
                        containerRef.current?.requestFullscreen();
                    }}
                    className="absolute bottom-10 right-10 bg-white/10 hover:bg-white/30 text-white/80 px-6 py-3 rounded-full font-bold backdrop-blur transition-all border border-white/10 z-50"
                >
                    ⤢ Enter Fullscreen
                </button>
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 animate-[fadeOut_5s_forwards] delay-1000">
                <div className="bg-black/50 text-white px-4 py-2 rounded text-sm font-bold backdrop-blur">
                    Double Click or 'F' (Fullscreen) | 'A' (Aspect Ratio)
                </div>
            </div>
        </div>
    );
};

export default function App() {
    const params = new URLSearchParams(window.location.search);
    const outIdx = params.get('output');
    if (outIdx !== null) return <OutputWindow index={parseInt(outIdx)} />;

    // Check for Firmware Upload Page
    if (params.get('page') === 'firmware') return <FirmwareUpload />;

    // --- State ---
    const loadConfig = (): ProjectorConfig[] => {
        try {
            const saved = localStorage.getItem('lumina-config-v4'); // v3 for new props
            if (saved) return JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }
        return DEFAULT_CONFIGS();
    };

    const [projectors, setProjectors] = useState<ProjectorConfig[]>(loadConfig);
    const [selectedProjector, setSelectedProjector] = useState(0);
    const [selectedPoints, setSelectedPoints] = useState<{ r: number, c: number }[]>([]);

    // Canvas / Total Resolution
    const [totalResolution, setTotalResolution] = useState(() => {
        try {
            const saved = localStorage.getItem('lumina-resolution');
            if (saved) return JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }
        return { width: 1920, height: 1080 };
    });

    useEffect(() => {
        localStorage.setItem('lumina-resolution', JSON.stringify(totalResolution));
    }, [totalResolution]);

    // Masking State
    const [activeTool, setActiveTool] = useState<'move' | 'mask'>('move');
    const [drawingMask, setDrawingMask] = useState<Point[]>([]);

    // Video State
    const [isPlaying, setIsPlaying] = useState(false);

    // Playlist State (Idle + Main)
    // Initialize with default videos directly to avoid "Empty src" errors
    const [idleVideoUrl, setIdleVideoUrl] = useState<string>('/videos/idle_loop.mp4');
    const [mainVideoUrl, setMainVideoUrl] = useState<string>('/videos/main_content.mp4');
    const [playbackState, setPlaybackState] = useState<'IDLE' | 'MAIN' | 'TRANSITION'>('IDLE');
    const [mixValue, setMixValue] = useState(0); // 0 = Idle, 1 = Main
    const [isLedBroadcastEnabled, setIsLedBroadcastEnabled] = useState(false);
    const [ledDataRowY, setLedDataRowY] = useState(0.99); // Normalized 0-1 (99% default)
    const [ledPreviewData, setLedPreviewData] = useState<Uint8Array | null>(null);
    const [collapsedSections, setCollapsedSections] = useState<string[]>([]);
    const [isLedFlipped, setIsLedFlipped] = useState(false);
    const [activePattern, setActivePattern] = useState(0); // 0 = Video

    // Undo History
    const [history, setHistory] = useState<ProjectorConfig[][]>([]);

    const pushHistory = useCallback(() => {
        setHistory(prev => {
            const snapshot = JSON.parse(JSON.stringify(projectors));
            return [snapshot, ...prev].slice(0, 50); // limit 50 steps
        });
    }, [projectors]);

    const undo = useCallback(() => {
        setHistory(prev => {
            if (prev.length === 0) return prev;
            const [last, ...remaining] = prev;
            setProjectors(last);

            // Update renderer for all
            last.forEach((proj, i) => {
                rendererRef.current?.updateGridWarp(i, proj.grid, proj.rows, proj.cols, proj.mode);
                rendererRef.current?.updateInputCrop(i, proj.crop);
                rendererRef.current?.updateEdgeBlend(i, proj.edgeBlend);
            });

            localStorage.setItem('lumina-config-v4', JSON.stringify(last));
            return remaining;
        });
    }, []);

    const fullReset = () => {
        pushHistory();
        const rows = 2, cols = 2;
        const defaultGrid = createDefaultGrid(rows, cols);

        setProjectors(prev => {
            const next = [...prev];
            next[selectedProjector] = {
                ...next[selectedProjector],
                rows,
                cols,
                grid: defaultGrid,
                mode: 'linear'
            };
            localStorage.setItem('lumina-config-v4', JSON.stringify(next));
            return next;
        });

        if (rendererRef.current) {
            rendererRef.current.updateGridWarp(selectedProjector, defaultGrid, rows, cols, 'linear');
        }
        setSelectedPoints([]);
    };

    const applyLayoutPreset = (type: 'DEFAULT' | 'PUC_SALA_1') => {
        // if (!confirm('This will overwrite current Crop and Overlap settings. Continue?')) return;
        pushHistory();

        setProjectors(prev => {
            const next = prev.map(p => ({ ...p })); // Clone

            if (type === 'DEFAULT') {
                setTotalResolution({ width: 5760, height: 1080 });
                // 3x1 Simple Split
                next.forEach((p, i) => {
                    p.crop = { x: i * (1 / 3), y: 0, width: 1 / 3, height: 1 };
                    p.edgeBlend = { left: 0, right: 0, top: 0, bottom: 0, gamma: 1.0 };
                });
            } else if (type === 'PUC_SALA_1') {
                const TOTAL_W = 5006;
                setTotalResolution({ width: 5006, height: 1080 });

                const PROJ_W = 1920;
                const OVERLAP = 377; // 377 pixels

                // Projector 1: Starts at 0
                next[0].crop = { x: 0, y: 0, width: PROJ_W / TOTAL_W, height: 1 };
                // Blend Right only
                next[0].edgeBlend = { ...next[0].edgeBlend, right: (OVERLAP / PROJ_W), left: 0 };

                // Projector 2: Starts at 1920 - 377 = 1543
                const p2Start = 1543;
                next[1].crop = { x: p2Start / TOTAL_W, y: 0, width: PROJ_W / TOTAL_W, height: 1 };
                // Blend Both
                next[1].edgeBlend = { ...next[1].edgeBlend, left: (OVERLAP / PROJ_W), right: (OVERLAP / PROJ_W) }; // normalized to Projector Width (0..1)

                // Projector 3: Starts at 3463 - 377 = 3086 (Check: 3086 + 1920 = 5006. OK.)
                const p3Start = 3086;
                next[2].crop = { x: p3Start / TOTAL_W, y: 0, width: PROJ_W / TOTAL_W, height: 1 };
                // Blend Left only
                next[2].edgeBlend = { ...next[2].edgeBlend, left: (OVERLAP / PROJ_W), right: 0 };

            }

            localStorage.setItem('lumina-config-v4', JSON.stringify(next));
            return next;
        });
    };

    const toggleSection = (id: string) => {
        setCollapsedSections(prev =>
            prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
        );
    };

    // LED Bridge
    const { isConnected: isLedBridgeConnected, sendData: sendLedData, sendJson, lastMessage } = useLedBridge();
    const [ports, setPorts] = useState<{ path: string, manufacturer?: string }[]>([]);
    const [selectedPort, setSelectedPort] = useState('');

    useEffect(() => {
        if (isLedBridgeConnected) {
            // Request ports on connect
            sendJson({ type: 'GET_PORTS' });
        }
    }, [isLedBridgeConnected, sendJson]);

    useEffect(() => {
        if (lastMessage && lastMessage.type === 'PORTS_LIST') {
            setPorts(lastMessage.ports);
        }
        if (lastMessage && lastMessage.type === 'PORT_SET') {
            setSelectedPort(lastMessage.port);
        }
    }, [lastMessage]);

    const handlePortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const port = e.target.value;
        setSelectedPort(port);
        sendJson({ type: 'SET_PORT', port });
    };

    // Refs
    const rendererRef = useRef<ThreeRenderer | null>(null);
    const idleVideoRef = useRef<HTMLVideoElement | null>(null);
    const mainVideoRef = useRef<HTMLVideoElement | null>(null);
    const containerRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
    const sourceMonitorRef = useRef<HTMLCanvasElement>(null);

    // We use a REF for selection to ensure Drag/Move has latest without re-attaching listeners constantly
    const selectionRef = useRef<{ r: number, c: number }[]>([]);
    useEffect(() => { selectionRef.current = selectedPoints }, [selectedPoints]);

    // 1. Initialize Renderer
    useEffect(() => {
        if (containerRefs[0].current && containerRefs[1].current && containerRefs[2].current && !rendererRef.current) {
            console.log('[App] Initializing Renderer');
            rendererRef.current = new ThreeRenderer([
                { index: 0, container: containerRefs[0].current! },
                { index: 1, container: containerRefs[1].current! },
                { index: 2, container: containerRefs[2].current! }
            ]);

            // Initial Push
            projectors.forEach((proj, i) => {
                rendererRef.current?.updateInputCrop(i, proj.crop);
                rendererRef.current?.updateGridWarp(i, proj.grid, proj.rows, proj.cols, proj.mode);
            });
        }
        return () => {
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
    }, []);

    // 4. Update Renderer on Config Change (Crop/Warp) & Pattern
    // This effect now ONLY handles non-drag updates (initial load, undo, reset, crop sliders)
    useEffect(() => {
        if (!rendererRef.current) return;
        projectors.forEach((proj, i) => {
            rendererRef.current?.updateInputCrop(i, proj.crop);
            if (proj.edgeBlend) rendererRef.current?.updateEdgeBlend(i, proj.edgeBlend);
            rendererRef.current?.updateGridWarp(i, proj.grid, proj.rows, proj.cols, proj.mode);
        });
        // Update Pattern GLOBAL for all projectors for now
        const customUrl = activePattern === 5 ? '/pattern/pattern-5006x1080.png' : undefined;
        rendererRef.current.setPattern(activePattern, customUrl);
    }, [projectors, activePattern]);

    // Crossfade Logic
    const fadeTo = (target: 'IDLE' | 'MAIN') => {
        const start = performance.now();
        const duration = 2000; // 2 seconds fade
        const startMix = target === 'MAIN' ? 0 : 1;
        const endMix = target === 'MAIN' ? 1 : 0;

        // Ensure target video is playing
        if (target === 'MAIN' && mainVideoRef.current) {
            mainVideoRef.current.currentTime = 0;
            mainVideoRef.current.play().catch(console.error);
        } else if (target === 'IDLE' && idleVideoRef.current) {
            idleVideoRef.current.play().catch(console.error);
        }

        setPlaybackState('TRANSITION');

        const animate = (time: number) => {
            const elapsed = time - start;
            const progress = Math.min(elapsed / duration, 1);

            // Ease in-out
            const ease = progress < .5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

            const currentMix = startMix + (endMix - startMix) * ease;
            setMixValue(currentMix);
            rendererRef.current?.setCrossfade(currentMix);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                setMixValue(endMix);
                setPlaybackState(target);
                // If went back to IDLE, pause MAIN
                if (target === 'IDLE' && mainVideoRef.current) {
                    mainVideoRef.current.pause();
                }
            }
        };
        requestAnimationFrame(animate);
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Undo Shortcut
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                undo();
            }

            // Space or 'T' to trigger Main
            if ((e.code === 'Space' || e.key.toLowerCase() === 't') && playbackState === 'IDLE') {
                console.log("Triggering Main Content");
                fadeTo('MAIN');
            }
            // 'I' to force back to Idle
            if (e.key.toLowerCase() === 'i' && playbackState === 'MAIN') {
                console.log("Forcing Return to Idle");
                fadeTo('IDLE');
            }

            // Arrow keys for precision move
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedPoints.length > 0) {
                e.preventDefault();
                pushHistory();
                const step = e.shiftKey ? 5 : 1;
                let dx = 0, dy = 0;
                if (e.key === 'ArrowUp') dy = -step;
                if (e.key === 'ArrowDown') dy = step;
                if (e.key === 'ArrowLeft') dx = -step;
                if (e.key === 'ArrowRight') dx = step;

                updateProjector(selectedProjector, active => {
                    const newGrid = active.grid.map(row => row.map(p => ({ ...p })));
                    selectedPoints.forEach(pt => {
                        newGrid[pt.r][pt.c].x += dx;
                        newGrid[pt.r][pt.c].y += dy;
                    });
                    if (active.mode === 'bicubic') return { ...active, grid: calculateInternalPoints(newGrid) };
                    return { ...active, grid: newGrid };
                });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [playbackState, selectedPoints, selectedProjector, undo, pushHistory]);

    // OSC Command Listener
    useEffect(() => {
        const socket = io('http://localhost:3001');

        socket.on('connect', () => {
            console.log("Connected to OSC Bridge");
        });

        socket.on('osc-command', (data: { command: string, args: any[] }) => {
            console.log("OSC Command Received:", data.command);

            // Only handle commands via FadeTo logic where appropriate
            if (data.command === 'main' && playbackState === 'IDLE') {
                fadeTo('MAIN');
            } else if (data.command === 'idle' && playbackState === 'MAIN') {
                fadeTo('IDLE');
            } else if (data.command === 'play') {
                if (idleVideoRef.current) idleVideoRef.current.play().catch(console.error);
                if (mainVideoRef.current) mainVideoRef.current.play().catch(console.error);
            } else if (data.command === 'pause') {
                if (idleVideoRef.current) idleVideoRef.current.pause();
                if (mainVideoRef.current) mainVideoRef.current.pause();
            } else if (data.command === 'stop') {
                if (idleVideoRef.current) { idleVideoRef.current.pause(); idleVideoRef.current.currentTime = 0; }
                if (mainVideoRef.current) { mainVideoRef.current.pause(); mainVideoRef.current.currentTime = 0; }
                fadeTo('IDLE'); // Reset to Start state
            }
        });

        return () => {
            socket.disconnect();
        };
    }, [playbackState]); // Re-connect/bind when state changes to capture correct closure logic? 
    // Actually, fadeTo is stable in scope, but playbackState inside fadeTo logic is closure-captured if not updated.
    // However, fadeTo implementation uses setters, so it's strictly functional. But the `if` checks above use `playbackState`.
    // So dependency is correct.

    // Use a Ref for mixValue to avoid re-creating the interval constantly
    const mixValueRef = useRef(mixValue);
    useEffect(() => { mixValueRef.current = mixValue; }, [mixValue]);

    // Sync Master (Dual Video)
    const broadcastSync = () => {
        const channel = new BroadcastChannel('lumina_sync');
        channel.postMessage({
            type: 'SYNC',
            idleSrc: idleVideoRef.current?.src || '',
            mainSrc: mainVideoRef.current?.src || '',
            idleTime: idleVideoRef.current?.currentTime || 0,
            mainTime: mainVideoRef.current?.currentTime || 0,
            idlePaused: idleVideoRef.current?.paused || false,
            mainPaused: mainVideoRef.current?.paused || false,
            mix: mixValueRef.current,
            syncProjectors: projectors // Include full config for real-time blending/warp sync
        });
        channel.close();
    };

    useEffect(() => {
        const channel = new BroadcastChannel('lumina_sync');
        channel.onmessage = (e) => {
            if (e.data.type === 'HELLO') {
                console.log("New Output Window detected. Sending Sync...");
                broadcastSync();
            }
        };
        const interval = setInterval(broadcastSync, 33);
        return () => { clearInterval(interval); channel.close(); };
    }, []); // Empty dependency array = Stable Interval!

    // 3. Video Handling - Update Renderer with current Refs
    useEffect(() => {
        if (!rendererRef.current) return;
        console.log("Setting Videos refs", idleVideoRef.current, mainVideoRef.current);
        rendererRef.current.setVideos(idleVideoRef.current, mainVideoRef.current);

        // Force play idle to ensure texture update
        if (idleVideoRef.current && idleVideoRef.current.paused) {
            idleVideoRef.current.play().catch(e => console.warn("Auto-play blocked", e));
        }
    }, [idleVideoUrl, mainVideoUrl, rendererRef.current]);

    // Auto-Return to Idle when Main ends
    useEffect(() => {
        const mainInfo = mainVideoRef.current;
        if (!mainInfo) return;

        const onEnd = () => {
            console.log("Main Content Ended. Returning to Idle...");
            fadeTo('IDLE');
        };
        mainInfo.addEventListener('ended', onEnd);
        return () => mainInfo.removeEventListener('ended', onEnd);
    }, []);

    // 6. LED Sampling Loop
    useEffect(() => {
        if (!isLedBroadcastEnabled || !isLedBridgeConnected) return;

        let lastTime = 0;
        const fps = 30;
        const interval = 1000 / fps;

        let rafId: number;
        const sampleAndSend = (time: number) => {
            if (time - lastTime >= interval) {
                if (rendererRef.current) {
                    // Sample based on method
                    let pixelData: Uint8Array | null = null;

                    // Always sample from MIXED source (Follows crossfade A/B)
                    pixelData = rendererRef.current.sampleMixedSource(180, ledDataRowY, mixValue);

                    if (pixelData) {
                        // Flip data if needed (for reverse-wired LED strips)
                        if (isLedFlipped) {
                            const flipped = new Uint8Array(pixelData.length);
                            const count = pixelData.length / 3;
                            for (let i = 0; i < count; i++) {
                                const src = (count - 1 - i) * 3;
                                const dst = i * 3;
                                flipped[dst] = pixelData[src];
                                flipped[dst + 1] = pixelData[src + 1];
                                flipped[dst + 2] = pixelData[src + 2];
                            }
                            pixelData = flipped;
                        }

                        sendLedData(pixelData);
                        setLedPreviewData(pixelData);
                    }

                    // Update LED Monitor in Sidebar
                    if (sourceMonitorRef.current && rendererRef.current) {
                        const ctx = sourceMonitorRef.current.getContext('2d');
                        if (ctx) {
                            const monW = sourceMonitorRef.current.width;
                            const monH = sourceMonitorRef.current.height;
                            ctx.clearRect(0, 0, monW, monH);

                            // Draw the raw sampling row onto the monitor (zoomed in visually)
                            // Show the dominant video in the monitor
                            const video = (mixValue > 0.5) ? mainVideoRef.current : idleVideoRef.current;
                            if (video && video.readyState >= 2) {
                                // Draw thumbnail of video
                                ctx.globalAlpha = 0.5;
                                ctx.drawImage(video, 0, 0, monW, monH);
                                ctx.globalAlpha = 1.0;

                                // Draw sampling line on thumbnail
                                const yPos = ledDataRowY * monH;
                                ctx.strokeStyle = '#3b82f6';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.moveTo(0, yPos);
                                ctx.lineTo(monW, yPos);
                                ctx.stroke();

                                // Draw LABELS
                                ctx.fillStyle = "white";
                                ctx.font = "8px monospace";
                                ctx.fillText(`SRC: MIXED (CLEAN)`, 5, 10);

                                // Draw a representative "glow" of the sampled data at the bottom of thumbnail
                                if (pixelData) {
                                    const step = monW / 180;
                                    for (let i = 0; i < 180; i++) {
                                        ctx.fillStyle = `rgb(${pixelData[i * 3]},${pixelData[i * 3 + 1]},${pixelData[i * 3 + 2]})`;
                                        ctx.fillRect(i * step, monH - 10, step + 1, 10);
                                    }
                                }
                            }
                        }
                    }
                }
                lastTime = time;
            }
            rafId = requestAnimationFrame(sampleAndSend);
        };

        rafId = requestAnimationFrame(sampleAndSend);
        return () => cancelAnimationFrame(rafId);
    }, [isLedBroadcastEnabled, isLedBridgeConnected, ledDataRowY, mixValue, isLedFlipped, sendLedData]);

    // --- Logic ---

    const updateProjector = (index: number, updater: (prev: ProjectorConfig) => ProjectorConfig) => {
        setProjectors(prev => {
            const next = [...prev];
            next[index] = updater(next[index]);
            return next;
        });
    };

    const setMode = (mode: 'linear' | 'bicubic') => {
        pushHistory();
        updateProjector(selectedProjector, prev => {
            let newRows = prev.rows;
            let newCols = prev.cols;
            let newGrid = prev.grid;

            if (mode === 'bicubic') {
                // Switching to Bezier: Ensure at least 4x4 for useful cubic patches
                if (prev.rows < 4 || prev.cols < 4) {
                    newRows = Math.max(4, prev.rows);
                    newCols = Math.max(4, prev.cols);
                    newGrid = resampleGrid(prev.grid, prev.rows, prev.cols, newRows, newCols, prev.mode);
                }
            }
            // Note: We don't downgrade to 2x2 automatically when switching to linear,
            // to allow linear interpolation on higher density grids.

            return {
                ...prev,
                mode,
                rows: newRows,
                cols: newCols,
                grid: newGrid
            };
        });
        setSelectedPoints([]);
    };

    const changeGridResolution = (dRows: number, dCols: number) => {
        pushHistory();
        updateProjector(selectedProjector, prev => {
            const newRows = Math.max(2, prev.rows + dRows);
            const newCols = Math.max(2, prev.cols + dCols);

            // Critical: Resample to maintain visual shape
            const newGrid = resampleGrid(prev.grid, prev.rows, prev.cols, newRows, newCols, prev.mode);

            return {
                ...prev,
                rows: newRows,
                cols: newCols,
                grid: newGrid
            };
        });
        setSelectedPoints([]);
    };

    const updateCrop = (field: keyof Crop, value: number) => {
        pushHistory();
        updateProjector(selectedProjector, prev => ({
            ...prev,
            crop: { ...prev.crop, [field]: value }
        }));
    };

    const handleDragStart = (projIdx: number, rStart: number, cStart: number, e: React.MouseEvent) => {
        e.preventDefault();
        pushHistory();

        // Update selection if not clicking on already selected point
        const isSelected = selectedPoints.some(p => p.r === rStart && p.c === cStart);
        if (!isSelected && !e.shiftKey) {
            setSelectedPoints([{ r: rStart, c: cStart }]);
            selectionRef.current = [{ r: rStart, c: cStart }];
        }

        const startX = e.clientX;
        const startY = e.clientY;
        const initialGridSnapshot = projectors[projIdx].grid.map(row => row.map(pt => ({ ...pt })));

        // Use a ref-like object for "hot" variables to be read by RequestAnimationFrame
        const latestDelta = { x: 0, y: 0 };
        let rafId: number;

        const syncDrag = () => {
            const dx = latestDelta.x;
            const dy = latestDelta.y;

            setProjectors(prev => {
                const next = [...prev];
                const active = next[projIdx];
                let newGrid = initialGridSnapshot.map(row => row.map(pt => ({ ...pt })));

                const corners = [
                    { r: 0, c: 0 }, { r: 0, c: active.cols - 1 },
                    { r: active.rows - 1, c: 0 }, { r: active.rows - 1, c: active.cols - 1 }
                ];

                selectionRef.current.forEach(pt => {
                    const isCorner = active.mode === 'bicubic' && corners.some(c => c.r === pt.r && c.c === pt.c);

                    if (newGrid[pt.r] && newGrid[pt.r][pt.c]) {
                        newGrid[pt.r][pt.c].x += dx;
                        newGrid[pt.r][pt.c].y += dy;
                    }

                    // Move Handles relative to corner if corner moved
                    if (isCorner) {
                        const r = pt.r; const c = pt.c;
                        const rowH = (r === 0) ? 1 : active.rows - 2;
                        const colH = (c === 0) ? 1 : active.cols - 2;
                        if (newGrid[r][colH]) { newGrid[r][colH].x += dx; newGrid[r][colH].y += dy; }
                        if (newGrid[rowH][c]) { newGrid[rowH][c].x += dx; newGrid[rowH][c].y += dy; }
                    }
                });

                if (active.mode === 'bicubic' && active.rows === 4 && active.cols === 4) {
                    newGrid = calculateInternalPoints(newGrid);
                }

                next[projIdx] = { ...active, grid: newGrid };

                // DIRECT RENDERER UPDATE (Low Latency)
                if (rendererRef.current) {
                    rendererRef.current.updateGridWarp(projIdx, newGrid, active.rows, active.cols, active.mode);
                }

                return next;
            });

            rafId = requestAnimationFrame(syncDrag);
        };

        const onMove = (m: MouseEvent) => {
            latestDelta.x = (m.clientX - startX) / 0.9;
            latestDelta.y = (m.clientY - startY) / 0.9;
        };

        const onUp = () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            // Save to LocalStorage only when drag ends to avoid blocking hot path
            setProjectors(prev => {
                localStorage.setItem('lumina-config-v4', JSON.stringify(prev));
                return prev;
            });
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        rafId = requestAnimationFrame(syncDrag);
    };

    const resetPoint = (r: number, c: number) => {
        pushHistory();
        updateProjector(selectedProjector, active => {
            const newGrid = active.grid.map(row => row.map(p => ({ ...p })));
            const defaultX = (c / (active.cols - 1)) * 360;
            const defaultY = (r / (active.rows - 1)) * 202;
            newGrid[r][c] = { x: defaultX, y: defaultY };
            if (active.mode === 'bicubic' && active.rows === 4 && active.cols === 4) return { ...active, grid: calculateInternalPoints(newGrid) };
            return { ...active, grid: newGrid };
        });
    };

    const handlePointMouseDown = (projIdx: number, r: number, c: number, e: React.MouseEvent) => {
        e.stopPropagation();
        if (selectedProjector !== projIdx) setSelectedProjector(projIdx);

        const isCurrentlySelected = selectedPoints.some(p => p.r === r && p.c === c);
        if (e.shiftKey) {
            if (isCurrentlySelected) {
                setSelectedPoints(prev => prev.filter(p => !(p.r === r && p.c === c)));
                selectionRef.current = selectionRef.current.filter(p => !(p.r === r && p.c === c));
            } else {
                setSelectedPoints(prev => [...prev, { r, c }]);
                selectionRef.current = [...selectionRef.current, { r, c }];
            }
        } else {
            if (!isCurrentlySelected) {
                setSelectedPoints([{ r, c }]);
                selectionRef.current = [{ r, c }];
            }
        }

        handleDragStart(projIdx, r, c, e);
    };

    return (
        <div className="flex h-screen bg-[#0a0e1a] text-slate-300">
            {/* Hidden Videos for Controller */}
            <video
                ref={idleVideoRef}
                src={idleVideoUrl}
                loop
                muted
                playsInline
                onPlay={() => { console.log('Ctl Idle : Playing'); broadcastSync(); }}
                onPause={() => { console.log('Ctl Idle : Paused'); broadcastSync(); }}
                onError={(e) => console.error('Ctl Idle Error:', e.currentTarget.error)}
                onLoadedMetadata={(e) => console.log('Ctl Idle Loaded:', e.currentTarget.videoWidth, 'x', e.currentTarget.videoHeight)}
                style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0.01, pointerEvents: 'none' }}
            />
            <video
                ref={mainVideoRef}
                src={mainVideoUrl}
                muted
                playsInline
                onPlay={() => { console.log('Ctl Main : Playing'); broadcastSync(); }}
                onPause={() => { console.log('Ctl Main : Paused'); broadcastSync(); }}
                onError={(e) => console.error('Ctl Main Error:', e.currentTarget.error)}
                onLoadedMetadata={(e) => console.log('Ctl Main Loaded:', e.currentTarget.videoWidth, 'x', e.currentTarget.videoHeight)}
                style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0.01, pointerEvents: 'none' }}
            />

            <aside className="w-64 bg-[#0f1419] border-r border-white/10 p-6 flex flex-col gap-6 overflow-y-auto z-10 shrink-0">
                <div>
                    <h1 className="text-xl font-bold text-white mb-1">Lumina Mapper</h1>
                    <div className="text-xs text-slate-600">3 x 1920x1080 Projectors</div>
                </div>

                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Projectors</h2>
                        <button
                            onClick={() => window.open(`/?output=${selectedProjector}`, `P${selectedProjector + 1}`, 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no')}
                            className="p-1 px-2 rounded bg-white/5 hover:bg-white/10 text-[9px] text-white/50 flex items-center gap-1 transition-all border border-white/5 active:scale-95"
                        >
                            <ExternalLink size={10} /> OUT #{selectedProjector + 1}
                        </button>
                    </div>

                    <div className="flex bg-black/40 p-1 rounded-xl border border-white/5 shadow-inner">
                        {projectors.map((_, i) => (
                            <button
                                key={i}
                                onClick={() => setSelectedProjector(i)}
                                className={`flex-1 flex flex-col items-center justify-center py-2.5 rounded-lg transition-all duration-300 relative group ${selectedProjector === i
                                    ? 'bg-amber-500 text-black shadow-[0_0_15px_rgba(245,158,11,0.3)]'
                                    : 'text-slate-500 hover:bg-white/5 hover:text-white'
                                    }`}
                            >
                                <span className={`text-[11px] font-black ${selectedProjector === i ? 'scale-110' : ''}`}>
                                    {i + 1}
                                </span>
                                <span className="text-[6px] uppercase font-bold opacity-40 group-hover:opacity-100 transition-opacity">
                                    P{i + 1}
                                </span>
                                {selectedProjector === i && (
                                    <div className="absolute -bottom-1 w-1 h-1 bg-black rounded-full" />
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="h-px bg-white/5 mx-2" />

                {/* Layout Presets (Moved to Top) */}
                <div className="p-3 bg-white/5 rounded border border-white/5 space-y-2">
                    <h2 className="text-xs font-bold text-slate-500 uppercase">Layout Presets</h2>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => applyLayoutPreset('DEFAULT')}
                            className="text-[10px] bg-slate-800 hover:bg-slate-700 py-2 rounded text-slate-300"
                        >
                            3x1 Standard
                        </button>
                        <button
                            onClick={() => applyLayoutPreset('PUC_SALA_1')}
                            className="text-[10px] font-bold bg-amber-500/20 hover:bg-amber-500/40 border border-amber-500/50 py-2 rounded text-amber-500 active:scale-95 transition-all"
                        >
                            PUC Sala 1 (5006px)
                        </button>
                    </div>
                </div>

                <div className="h-px bg-white/5 mx-2" />

                {/* LED Bridge Section - Collapsible */}
                <div className="space-y-2">
                    <button
                        onClick={() => toggleSection('led')}
                        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-colors py-1 group"
                    >
                        <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full ${isLedBridgeConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                            LED Bridge
                        </div>
                        <ChevronDown size={12} className={`transition-transform duration-300 ${collapsedSections.includes('led') ? '-rotate-90' : ''}`} />
                    </button>

                    {!collapsedSections.includes('led') && (
                        <div className="space-y-3 py-3 bg-white/5 rounded-lg p-3 border border-white/5 animate-in fade-in slide-in-from-top-2 duration-300">
                            {/* Port Selection Integration */}
                            {isLedBridgeConnected ? (
                                <div className="flex gap-2 mb-2 pb-2 border-b border-white/5">
                                    <select
                                        value={selectedPort}
                                        onChange={handlePortChange}
                                        className="w-full bg-black/50 border border-white/10 rounded px-2 py-1 text-[10px] outline-none hover:border-white/30 transition-colors"
                                    >
                                        <option value="" disabled>Select Serial Port</option>
                                        {ports.map(p => (
                                            <option key={p.path} value={p.path}>
                                                {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        onClick={() => sendJson({ type: 'GET_PORTS' })}
                                        className="p-1.5 bg-white/5 hover:bg-white/10 rounded border border-white/5 text-white/50 hover:text-white"
                                        title="Refresh Ports"
                                    >
                                        <RotateCcw size={10} />
                                    </button>
                                    <a
                                        href="/?page=firmware"
                                        target="_blank"
                                        className="p-1.5 bg-white/5 hover:bg-white/10 rounded border border-white/5 text-white/50 hover:text-white flex items-center justify-center"
                                        title="Firmware Settings"
                                    >
                                        <Settings size={10} />
                                    </a>
                                </div>
                            ) : (
                                <div className="text-[10px] text-red-400 italic mb-2 pb-2 border-b border-white/5">
                                    Bridge Disconnected
                                </div>
                            )}

                            <div className="flex items-center justify-between">
                                <span className="text-[9px] font-bold text-white/20 uppercase">Streaming</span>
                                <button
                                    onClick={() => setIsLedBroadcastEnabled(!isLedBroadcastEnabled)}
                                    className={`px-3 py-1 rounded text-[9px] font-bold transition-all border ${isLedBroadcastEnabled
                                        ? 'bg-blue-600/20 border-blue-500 text-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.2)]'
                                        : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10'
                                        }`}
                                >
                                    {isLedBroadcastEnabled ? 'LIVE' : 'OFF AIR'}
                                </button>
                            </div>

                            <div className="space-y-2 pt-2 border-t border-white/5">
                                <div className="flex justify-between text-[9px] uppercase">
                                    <span className="text-slate-500">Target Line</span>
                                    <span className="text-amber-500 font-mono">{(ledDataRowY * 100).toFixed(1)}%</span>
                                </div>
                                <input
                                    type="range" min="0" max="1" step="0.001"
                                    value={ledDataRowY}
                                    onChange={(e) => setLedDataRowY(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                />
                                <div className="flex items-center justify-between pt-1">
                                    <button
                                        onClick={() => setIsLedFlipped(!isLedFlipped)}
                                        className={`px-2 py-0.5 rounded text-[8px] font-bold border transition-colors ${isLedFlipped ? 'bg-amber-500 text-black border-amber-500' : 'border-white/10 text-white/30 hover:bg-white/5'}`}
                                    >
                                        REVERSE
                                    </button>
                                    <div className="text-[7px] text-slate-600 italic leading-tight text-right uppercase">
                                        * 10px averaging
                                    </div>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-white/5">
                                <div className="relative rounded overflow-hidden bg-black aspect-video border border-white/10 group/mon">
                                    <canvas ref={sourceMonitorRef} width="200" height="112" className="w-full h-full opacity-60 group-hover/mon:opacity-100 transition-opacity" />
                                    <div className="absolute top-1 left-1 bg-black/80 px-1 rounded text-[6px] text-white/40 uppercase font-mono">Monitoring</div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>


                {/* Warp Mode */}
                <div className="space-y-3">
                    <button
                        onClick={() => toggleSection('warp')}
                        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-colors py-1 group"
                    >
                        Warp & Subdivision
                        <ChevronDown size={12} className={`transition-transform duration-300 ${collapsedSections.includes('warp') ? '-rotate-90' : ''}`} />
                    </button>

                    {!collapsedSections.includes('warp') && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                            <div className="flex bg-slate-900/50 rounded-lg p-1 border border-white/5">
                                {(['linear', 'bicubic'] as const).map(mode => (
                                    <button
                                        key={mode}
                                        onClick={() => setMode(mode)}
                                        className={`flex-1 py-1.5 text-[10px] uppercase font-black rounded-md transition-all ${projectors[selectedProjector].mode === mode
                                            ? 'bg-amber-500 text-black shadow-lg'
                                            : 'text-slate-500 hover:text-slate-300'
                                            }`}
                                    >
                                        {mode === 'linear' ? 'Quad' : 'Bezier'}
                                    </button>
                                ))}
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-[10px] bg-white/5 p-2 rounded-lg border border-white/5">
                                    <span className="text-slate-400 uppercase font-bold">Grid Rows</span>
                                    <div className="flex items-center gap-3">
                                        <button onClick={() => changeGridResolution(-1, 0)} className="p-1 hover:bg-white/10 rounded-full text-amber-500"><Minus size={12} /></button>
                                        <span className="font-mono text-white text-[11px] w-4 text-center">{projectors[selectedProjector].rows}</span>
                                        <button onClick={() => changeGridResolution(1, 0)} className="p-1 hover:bg-white/10 rounded-full text-amber-500"><Plus size={12} /></button>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between text-[10px] bg-white/5 p-2 rounded-lg border border-white/5">
                                    <span className="text-slate-400 uppercase font-bold">Grid Cols</span>
                                    <div className="flex items-center gap-3">
                                        <button onClick={() => changeGridResolution(0, -1)} className="p-1 hover:bg-white/10 rounded-full text-amber-500"><Minus size={12} /></button>
                                        <span className="font-mono text-white text-[11px] w-4 text-center">{projectors[selectedProjector].cols}</span>
                                        <button onClick={() => changeGridResolution(0, 1)} className="p-1 hover:bg-white/10 rounded-full text-amber-500"><Plus size={12} /></button>
                                    </div>
                                </div>
                            </div>

                            <div className="flex gap-2 pt-2 border-t border-white/5">
                                <button
                                    onClick={undo}
                                    disabled={history.length === 0}
                                    className={`flex-1 py-1.5 text-[9px] uppercase font-bold rounded-lg flex items-center justify-center gap-1 border border-white/5 transition-all
                                        ${history.length > 0 ? 'bg-white/5 text-white hover:bg-white/10 active:scale-95' : 'text-white/20 cursor-not-allowed opacity-50'}`}
                                >
                                    <RotateCcw size={10} className="-scale-x-100" /> Undo
                                </button>
                                <button
                                    onClick={fullReset}
                                    className="px-3 py-1.5 text-[9px] uppercase font-bold rounded-lg text-red-400 hover:text-white hover:bg-red-600/20 border border-white/5 transition-all active:scale-95"
                                >
                                    Full Reset
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Input Mapping */}
                <div className="space-y-3">
                    <button
                        onClick={() => toggleSection('input')}
                        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-colors py-1 group"
                    >
                        Input Mapping
                        <ChevronDown size={12} className={`transition-transform duration-300 ${collapsedSections.includes('input') ? '-rotate-90' : ''}`} />
                    </button>

                    {!collapsedSections.includes('input') && (
                        <div className="space-y-3 bg-white/5 rounded-lg p-3 border border-white/5 animate-in fade-in slide-in-from-top-2 duration-300">
                            {/* Canvas Size Reference */}
                            <div className="flex gap-2 mb-2 p-2 bg-black/20 rounded border border-white/5">
                                <div className="space-y-1 flex-1">
                                    <label className="text-[9px] text-slate-500 uppercase font-bold">Total Width</label>
                                    <input
                                        type="number"
                                        value={totalResolution.width}
                                        onChange={(e) => setTotalResolution((prev: { width: number; height: number }) => ({ ...prev, width: parseInt(e.target.value) || 1920 }))}
                                        className="w-full bg-slate-800 text-white px-1 py-0.5 rounded text-[10px] border border-slate-700"
                                    />
                                </div>
                                <div className="space-y-1 flex-1">
                                    <label className="text-[9px] text-slate-500 uppercase font-bold">Total Height</label>
                                    <input
                                        type="number"
                                        value={totalResolution.height}
                                        onChange={(e) => setTotalResolution((prev: { width: number; height: number }) => ({ ...prev, height: parseInt(e.target.value) || 1080 }))}
                                        className="w-full bg-slate-800 text-white px-1 py-0.5 rounded text-[10px] border border-slate-700"
                                    />
                                </div>
                            </div>

                            {['x', 'width', 'y', 'height'].map(field => {
                                const isX = field === 'x' || field === 'width';
                                const totalBase = isX ? totalResolution.width : totalResolution.height;
                                const currentVal = projectors[selectedProjector].crop[field as keyof Crop];
                                const pixelVal = Math.round(currentVal * totalBase);

                                return (
                                    <div key={field}>
                                        <div className="flex justify-between text-[9px] mb-1 uppercase font-bold">
                                            <span className="text-slate-500">{field}</span>
                                            <div className="flex gap-2">
                                                <span className="text-slate-400">{Math.round(currentVal * 100)}%</span>
                                                <span className="text-amber-500">{pixelVal}px</span>
                                            </div>
                                        </div>
                                        {/* Pixel Input */}
                                        <div className="flex gap-2 items-center mb-1">
                                            <input
                                                type="number"
                                                value={pixelVal}
                                                onChange={(e) => {
                                                    const px = parseFloat(e.target.value) || 0;
                                                    updateCrop(field as keyof Crop, px / totalBase);
                                                }}
                                                className="flex-1 bg-slate-800 text-amber-500 font-mono px-1 py-0.5 rounded text-[10px] border border-slate-700 focus:border-amber-500 outline-none"
                                            />
                                        </div>
                                        <input
                                            type="range" min={field.includes('width') || field.includes('height') ? 0.01 : 0} max="1" step="0.0001"
                                            value={currentVal}
                                            onChange={(e) => updateCrop(field as keyof Crop, parseFloat(e.target.value))}
                                            className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                        />
                                    </div>
                                );
                            })}

                            <div className="flex gap-4 pt-2 border-t border-white/5">
                                {['flipH', 'flipV'].map(f => (
                                    <label key={f} className="flex items-center gap-2 text-[9px] text-slate-500 uppercase font-bold cursor-pointer hover:text-white transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={projectors[selectedProjector][f as 'flipH' | 'flipV'] || false}
                                            onChange={(e) => {
                                                const newConfigs = [...projectors];
                                                newConfigs[selectedProjector][f as 'flipH' | 'flipV'] = e.target.checked;
                                                setProjectors(newConfigs);
                                            }}
                                            className="accent-amber-500"
                                        />
                                        {f.replace('flip', 'Flip ')}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Edge Blending */}
                <div className="space-y-3">
                    <button
                        onClick={() => toggleSection('blend')}
                        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-colors py-1 group"
                    >
                        Edge Blending
                        <ChevronDown size={12} className={`transition-transform duration-300 ${collapsedSections.includes('blend') ? '-rotate-90' : ''}`} />
                    </button>

                    {!collapsedSections.includes('blend') && (
                        <div className="p-3 bg-white/5 rounded-lg border border-white/5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                            <div className="space-y-3">
                                {['left', 'right', 'top', 'bottom'].map(side => (
                                    <div key={side}>
                                        <div className="flex justify-between text-[10px] mb-1 uppercase">
                                            <span className="text-slate-500">{side}</span>
                                            <span>{Math.round((projectors[selectedProjector].edgeBlend[side as keyof EdgeBlendConfig] as number) * 100)}%</span>
                                        </div>
                                        <input
                                            type="range" min="0" max="0.5" step="0.01"
                                            value={projectors[selectedProjector].edgeBlend[side as keyof EdgeBlendConfig]}
                                            onChange={(e) => {
                                                const newConfigs = [...projectors];
                                                newConfigs[selectedProjector].edgeBlend = {
                                                    ...newConfigs[selectedProjector].edgeBlend,
                                                    [side]: parseFloat(e.target.value)
                                                };
                                                const r = rendererRef.current;
                                                if (r) {
                                                    r.updateEdgeBlend(selectedProjector, newConfigs[selectedProjector].edgeBlend);
                                                }
                                                setProjectors(newConfigs);
                                            }}
                                            className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                        />
                                    </div>
                                ))}

                                {/* Gamma Slider */}
                                <div>
                                    <div className="flex justify-between text-[10px] mb-1 uppercase">
                                        <span className="text-slate-500">Smoothness (Gamma)</span>
                                        <span>{projectors[selectedProjector].edgeBlend.gamma || 1.0}</span>
                                    </div>
                                    <input
                                        type="range" min="0.1" max="4.0" step="0.1"
                                        value={projectors[selectedProjector].edgeBlend.gamma || 1.0}
                                        onChange={(e) => {
                                            const newConfigs = [...projectors];
                                            const val = parseFloat(e.target.value);
                                            newConfigs[selectedProjector].edgeBlend = {
                                                ...newConfigs[selectedProjector].edgeBlend,
                                                gamma: val
                                            };
                                            const r = rendererRef.current;
                                            if (r) {
                                                r.updateEdgeBlend(selectedProjector, newConfigs[selectedProjector].edgeBlend);
                                            }
                                            setProjectors(newConfigs);
                                        }}
                                        className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="h-px bg-white/5 mx-2" />

                {/* Playlist Status */}
                <div className="p-3 bg-white/5 rounded border border-white/5 space-y-4">
                    <h2 className="text-xs font-bold text-slate-500 uppercase flex justify-between">
                        Playback Status
                    </h2>
                    <div className="text-sm font-mono text-center py-2 bg-black/20 rounded">
                        STATE: <span className={playbackState === 'MAIN' ? 'text-red-500' : 'text-green-500'}>{playbackState}</span>
                    </div>
                    <div className="text-[10px] text-slate-500">
                        Mix Value: {mixValue.toFixed(2)}
                    </div>

                    {/* Manual Trigger */}
                    <button
                        onClick={() => fadeTo('MAIN')}
                        disabled={playbackState !== 'IDLE'}
                        className={`w-full py-3 font-bold rounded flex flex-col items-center justify-center ${playbackState !== 'IDLE' ? 'bg-slate-800 text-slate-500' : 'bg-red-600 text-white hover:bg-red-500'}`}
                    >
                        <span className="text-sm">TRIGGER MAIN (SPACE)</span>
                    </button>
                    <button
                        onClick={() => fadeTo('IDLE')}
                        disabled={playbackState === 'IDLE'}
                        className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-xs text-slate-400 rounded"
                    >
                        Force Return to Idle
                    </button>
                </div>

                {/* Test Patterns */}
                <TestPatterns activePattern={activePattern} onChange={setActivePattern} />


                {/* Playlist Control */}
                <div className="p-3 bg-white/5 rounded border border-white/5 space-y-4">
                    <h2 className="text-xs font-bold text-slate-500 uppercase flex justify-between">
                        Playlist Control
                        <span className={`text-[10px] px-2 rounded ${playbackState === 'IDLE' ? 'bg-slate-700' : 'bg-red-600 text-white animate-pulse'}`}>
                            {playbackState}
                        </span>
                    </h2>

                    {/* IDLE SLOT */}
                    <div className="space-y-2">
                        <div className="text-[10px] text-slate-400 uppercase mb-1">Idle Loop (Background)</div>
                        {/* Test Videos Dropdown */}
                        <select
                            value=""
                            onChange={(e) => {
                                if (e.target.value) {
                                    setIdleVideoUrl(e.target.value);
                                    // playVideo(e.target.value, 'IDLE'); // Removed
                                    if (idleVideoRef.current) {
                                        idleVideoRef.current.src = e.target.value;
                                        idleVideoRef.current.loop = true;
                                        idleVideoRef.current.play().catch(console.error);
                                    }
                                }
                            }}
                            className="w-full bg-slate-800 text-white px-2 py-1 rounded text-xs border border-slate-700 hover:border-slate-600"
                        >
                            <option value="">Select Video...</option>
                            {LOCAL_VIDEOS.length > 0 && <optgroup label="Local Project (/public/videos)">
                                {LOCAL_VIDEOS.map((v, i) => (
                                    <option key={`local-${i}`} value={`/videos/${v.filename}`}>{v.title}</option>
                                ))}
                            </optgroup>}
                            <optgroup label="Remote Tests">
                                {TEST_VIDEOS.map((video, i) => (
                                    <option key={i} value={video.url}>{video.title}</option>
                                ))}
                            </optgroup>
                        </select>
                        {/* Upload */}
                        <div className="flex gap-2">
                            <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                id="idle-upload"
                                onChange={(e) => {
                                    if (e.target.files?.[0]) {
                                        const url = URL.createObjectURL(e.target.files[0]);
                                        setIdleVideoUrl(url);
                                        // playVideo(url, 'IDLE'); // Removed
                                        if (idleVideoRef.current) {
                                            idleVideoRef.current.src = url;
                                            idleVideoRef.current.loop = true;
                                            idleVideoRef.current.play().catch(console.error);
                                        }
                                    }
                                }}
                            />
                            <label htmlFor="idle-upload" className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-xs cursor-pointer truncate flex-1 text-center">
                                {idleVideoUrl ? 'Upload Local File' : 'Upload Local File...'}
                            </label>
                            {idleVideoUrl && <button onClick={() => setIdleVideoUrl('')} className="text-red-500 hover:text-red-400">×</button>}
                        </div>
                        <div className="text-[9px] text-slate-600 text-center">
                            * Uploads are preview-only. Use /public/videos for Sync.
                        </div>
                    </div>
                </div>

                {/* MAIN SLOT */}
                <div className="space-y-2">
                    <div className="text-[10px] text-slate-400 uppercase mb-1">Main Content (One-Shot)</div>
                    {/* Dropdown */}
                    <select
                        value=""
                        onChange={(e) => {
                            if (e.target.value) setMainVideoUrl(e.target.value);
                        }}
                        className="w-full bg-slate-800 text-white px-2 py-1 rounded text-xs border border-slate-700 hover:border-slate-600"
                    >
                        <option value="">Select Video...</option>
                        {LOCAL_VIDEOS.length > 0 && <optgroup label="Local Project (/public/videos)">
                            {LOCAL_VIDEOS.map((v, i) => (
                                <option key={`local-${i}`} value={`/videos/${v.filename}`}>{v.title}</option>
                            ))}
                        </optgroup>}
                        <optgroup label="Remote Tests">
                            {TEST_VIDEOS.map((video, i) => (
                                <option key={i} value={video.url}>{video.title}</option>
                            ))}
                        </optgroup>
                    </select>
                    {/* Upload */}
                    <div className="flex gap-2">
                        <input
                            type="file"
                            accept="video/*"
                            className="hidden"
                            id="main-upload"
                            onChange={(e) => {
                                if (e.target.files?.[0]) setMainVideoUrl(URL.createObjectURL(e.target.files[0]));
                            }}
                        />
                        <label htmlFor="main-upload" className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-xs cursor-pointer truncate flex-1 text-center">
                            {mainVideoUrl ? 'Upload Local File' : 'Upload Local File...'}
                        </label>
                        {mainVideoUrl && <button onClick={() => setMainVideoUrl('')} className="text-red-500 hover:text-red-400">×</button>}
                    </div>
                </div>

                <div className="flex gap-2 pt-2 border-t border-white/5">
                    <button
                        onClick={() => {
                            if (!mainVideoUrl) return alert('No Main Video selected');
                            fadeTo('MAIN');
                        }}
                        disabled={!mainVideoUrl}
                        className={`flex-1 py-3 font-bold rounded flex flex-col items-center justify-center ${playbackState === 'MAIN' ? 'bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.5)]' : 'bg-slate-700 hover:bg-white/10'}`}
                    >
                        <span className="text-sm">PLAY MAIN</span>
                    </button>

                    <button
                        onClick={() => {
                            if (!idleVideoUrl) return alert('No Idle Video selected');
                            fadeTo('IDLE');
                        }}
                        disabled={!idleVideoUrl}
                        className="flex-1 py-3 bg-slate-700 hover:bg-white/10 font-bold rounded flex flex-col items-center justify-center"
                    >
                        <span className="text-sm">BACK TO IDLE</span>
                    </button>
                </div>

                <div className="pt-2 border-t border-white/5 space-y-2">
                    <button
                        onClick={() => window.open('/?output=0', '_blank', 'width=1280,height=720')}
                        className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white/70 text-xs rounded border border-white/5 flex items-center justify-center gap-2"
                    >
                        <ExternalLink size={12} /> Open Projector 1 Output
                    </button>
                </div>
            </aside>

            {/* Main Viewport */}
            <main className="flex-1 flex flex-col items-center justify-center p-8 bg-gradient-to-b from-transparent to-black/20 overflow-hidden select-none">
                <div className="flex flex-row flex-nowrap gap-4 transform scale-90 origin-center">
                    {projectors.map((config, i) => (
                        <div key={i} className="relative group">
                            {/* Header */}
                            <div className="text-xs text-slate-500 mb-2 font-bold uppercase tracking-wider flex justify-between pointer-events-none">
                                <span>P{i + 1}</span>
                                <span className={i === selectedProjector ? 'text-amber-500' : ''}>
                                    {config.mode === 'linear' ? 'Quad' : 'Bezier'}
                                </span>
                            </div>

                            {/* Canvas & Overlay Container */}
                            <div className="relative">
                                <div
                                    ref={containerRefs[i]}
                                    className={`rounded-sm overflow-hidden shadow-2xl ring-1 relative bg-black transition-all ${selectedProjector === i ? 'ring-amber-500/50 shadow-amber-500/10' : 'ring-white/10'
                                        }`}
                                    style={{ width: '360px', height: '202px' }}
                                    onMouseDown={() => setSelectedProjector(i)}
                                />

                                {/* SVG Overlay - Now perfectly aligned top-0 */}
                                <svg
                                    className="absolute top-0 left-0 overflow-visible pointer-events-none"
                                    width="360" height="202"
                                >
                                    {/* Invisible background for Canvas double-click interaction */}
                                    <rect
                                        width="360" height="202" fill="transparent"
                                        className="pointer-events-auto"
                                        onDoubleClick={() => changeGridResolution(1, 1)}
                                    />

                                    <g opacity={selectedProjector === i ? 1 : 0.3} className="transition-opacity duration-300">

                                        {/* --- GENERIC GRID VISUALIZATION --- */}
                                        {/* Draw horizontal lines - Double click to add a Row */}
                                        {config.grid.map((row, r) => (
                                            <polyline
                                                key={`h-${r}`}
                                                points={row.map(p => `${p.x},${p.y}`).join(' ')}
                                                fill="none"
                                                stroke={config.mode === 'bicubic' ? '#60a5fa' : '#f59e0b'}
                                                strokeWidth="3"
                                                strokeOpacity="0.3"
                                                className="cursor-pointer pointer-events-auto hover:stroke-white/50 transition-colors"
                                                onDoubleClick={(e) => { e.stopPropagation(); changeGridResolution(1, 0); }}
                                            />
                                        ))}
                                        {/* Draw vertical lines - Double click to add a Column */}
                                        {Array.from({ length: config.cols }).map((_, c) => (
                                            <polyline
                                                key={`v-${c}`}
                                                points={config.grid.map(row => `${row[c].x},${row[c].y}`).join(' ')}
                                                fill="none"
                                                stroke={config.mode === 'bicubic' ? '#60a5fa' : '#f59e0b'}
                                                strokeWidth="3"
                                                strokeOpacity="0.3"
                                                className="cursor-pointer pointer-events-auto hover:stroke-white/50 transition-colors"
                                                onDoubleClick={(e) => { e.stopPropagation(); changeGridResolution(0, 1); }}
                                            />
                                        ))}

                                        <g className="pointer-events-auto">
                                            {config.grid.map((row, r) => row.map((pt, c) => {
                                                const isSelected = selectedPoints.some(p => p.r === r && p.c === c);
                                                const isCorner = (r === 0 || r === config.rows - 1) && (c === 0 || c === config.cols - 1);

                                                return (
                                                    <g
                                                        key={`${r}-${c}`}
                                                        style={{ cursor: 'move' }}
                                                        onMouseDown={(e) => handlePointMouseDown(i, r, c, e)}
                                                        onDoubleClick={(e) => { e.stopPropagation(); resetPoint(r, c); }}
                                                    >
                                                        <circle cx={pt.x} cy={pt.y} r="10" fill="transparent" />
                                                        <circle
                                                            cx={pt.x} cy={pt.y} r={isCorner ? 5 : 3.5}
                                                            fill={isSelected ? '#fff' : (isCorner ? '#f59e0b' : '#60a5fa')}
                                                            stroke="#000" strokeWidth="1"
                                                            className="transition-none"
                                                        />
                                                    </g>
                                                );
                                            }))}
                                        </g>

                                        {/* LED Sampling Indicator Line - Global across all projectors */}
                                        {isLedBroadcastEnabled && (
                                            <line
                                                x1="-50" y1={ledDataRowY * 202}
                                                x2="410" y2={ledDataRowY * 202}
                                                stroke="#3b82f6"
                                                strokeWidth="2"
                                                strokeDasharray="4 2"
                                                className="drop-shadow-[0_0_8px_rgba(59,130,246,1)] pointer-events-none"
                                            />
                                        )}
                                    </g>
                                </svg>
                            </div>
                        </div>
                    ))}
                </div>

                {/* LED Preview Bar (Data Feedback) */}
                <div className="mt-12 flex flex-col items-center gap-3">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">
                        <div className={`w-1.5 h-1.5 rounded-full ${isLedBroadcastEnabled && isLedBridgeConnected ? 'bg-blue-500 animate-pulse' : 'bg-slate-700'}`} />
                        LED Streaming Feedback (180 Pixels)
                    </div>
                    <div
                        className="h-4 rounded bg-black/40 ring-1 ring-white/5 overflow-hidden flex shadow-2xl"
                        style={{ width: '1108px' }} // Matches the width of 3 projectors (360*3) + gaps (16*2)
                    >
                        {ledPreviewData ? (
                            Array.from({ length: 180 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="flex-1 h-full"
                                    style={{
                                        backgroundColor: ledPreviewData ? `rgb(${ledPreviewData[i * 3]}, ${ledPreviewData[i * 3 + 1]}, ${ledPreviewData[i * 3 + 2]})` : 'transparent',
                                        boxShadow: (isLedBroadcastEnabled && ledPreviewData) ? `0 0 10px rgba(${ledPreviewData[i * 3]}, ${ledPreviewData[i * 3 + 1]}, ${ledPreviewData[i * 3 + 2]}, 0.3)` : 'none'
                                    }}
                                />
                            ))
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-[9px] text-slate-700 italic">
                                Waiting for broadcast signal...
                            </div>
                        )}
                    </div>
                    <div className="text-[9px] text-slate-600 font-mono">
                        Source: Mixed (Clean) | Position: {(ledDataRowY * 100).toFixed(1)}%
                    </div>
                </div>
            </main >

        </div >
    );
}
