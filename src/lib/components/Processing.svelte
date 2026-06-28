<script lang="ts">
    import { base } from '$app/paths';
    import { onMount } from 'svelte';

    import { Progress } from '$lib/components/ui/progress/index.js';

    import { stitchSegments } from '$lib/videoStitcher.js';

    interface DeletedRange {
        startTime: number;
        endTime: number;
    }

    interface Props {
        segments?: Blob[];
        deletedRanges?: DeletedRange[];
        totalDuration?: number;
        oncomplete: (blob: Blob) => void;
    }

    let { segments = [], deletedRanges = [], totalDuration = 0, oncomplete }: Props = $props();

    let progress = $state(0);
    let status = $state('Preparing…');
    let errorMessage = $state<string | null>(null);

    onMount(() => {
        let worker: Worker | null = null;
        let cancelled = false;

        (async () => {
            try {
                // 1. Combine multiple segments natively (canvas + MediaRecorder), not
                //    ffmpeg — Chrome's VP9/alpha output crashes ffmpeg.wasm's encoder.
                let source = segments[0];
                if (segments.length > 1) {
                    status = 'Combining recordings…';
                    source = await stitchSegments(segments, (f) => {
                        progress = Math.round(f * 90);
                    });
                    if (cancelled) return;
                }

                // 2. No cuts → the combined/raw blob is already the final file.
                if (deletedRanges.length === 0) {
                    progress = 100;
                    status = 'Done!';
                    setTimeout(() => {
                        if (!cancelled) oncomplete(source);
                    }, 300);
                    return;
                }

                // 3. Cuts → trim with ffmpeg (-c copy only, no re-encode → no crash).
                status = 'Applying edits…';
                progress = 92;
                worker = new Worker(new URL('../ffmpegWorker.ts', import.meta.url), {
                    type: 'module'
                });
                worker.onmessage = (e: MessageEvent) => {
                    const { type } = e.data;
                    if (type === 'complete') {
                        progress = 100;
                        worker?.terminate();
                        setTimeout(() => {
                            if (!cancelled) oncomplete(e.data.blob);
                        }, 300);
                    } else if (type === 'error') {
                        errorMessage = e.data.message;
                        worker?.terminate();
                    }
                };
                worker.onerror = (e) => {
                    errorMessage = e.message ?? 'Unknown worker error';
                    worker?.terminate();
                };
                worker.postMessage({
                    segments: [source],
                    deletedRanges: [...deletedRanges].map((r) => ({
                        startTime: r.startTime,
                        endTime: r.endTime
                    })),
                    totalDuration,
                    coreBaseURL: `${window.location.origin}${base}/ffmpeg`
                });
            } catch (err) {
                if (!cancelled) errorMessage = err instanceof Error ? err.message : String(err);
            }
        })();

        return () => {
            cancelled = true;
            worker?.terminate();
        };
    });
</script>

<div class="flex h-full flex-col items-center justify-center p-8">
    {#if errorMessage}
        <div class="w-full max-w-sm space-y-2 text-center">
            <p class="text-sm font-medium text-destructive">Export failed</p>
            <p class="font-mono text-xs break-all text-muted-foreground">{errorMessage}</p>
        </div>
    {:else}
        <div class="w-full max-w-sm space-y-3">
            <div class="flex items-baseline justify-between text-sm">
                <span class="text-muted-foreground">{status}</span>
                <span class="font-mono tabular-nums">{progress}%</span>
            </div>
            <Progress value={progress} class="*:bg-indigo-500" />
        </div>
    {/if}
</div>
