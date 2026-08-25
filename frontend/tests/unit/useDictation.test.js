import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDictation } from '../../src/composables/useDictation.js';

function createDocumentMock() {
    const listeners = new Map();

    return {
        visibilityState: 'visible',
        addEventListener: vi.fn((type, handler) => {
            listeners.set(type, handler);
        }),
        removeEventListener: vi.fn((type) => {
            listeners.delete(type);
        }),
        emit(type) {
            const handler = listeners.get(type);
            if (handler) {
                handler();
            }
        },
    };
}

describe('useDictation', () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalNavigator = globalThis.navigator;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    let documentMock;
    let mediaTrack;
    let mediaStream;
    let recognitionInstance;
    let audioContextInstance;
    let analyserNode;
    let sourceNode;
    let rafQueue;

    function installBrowserMocks() {
        rafQueue = [];
        documentMock = createDocumentMock();
        mediaTrack = { stop: vi.fn() };
        mediaStream = {
            getTracks: vi.fn(() => [mediaTrack]),
        };

        class MockRecognition {
            constructor() {
                recognitionInstance = this;
                this.start = vi.fn(() => {
                    this.onstart?.();
                });
                this.stop = vi.fn();
                this.continuous = false;
                this.interimResults = false;
                this.maxAlternatives = 0;
                this.lang = '';
                this.onstart = null;
                this.onresult = null;
                this.onerror = null;
                this.onend = null;
            }
        }

        class MockAudioContext {
            constructor() {
                audioContextInstance = this;
                this.state = 'running';
                this.resume = vi.fn(async () => {});
                this.close = vi.fn(async () => {});
                this.createAnalyser = vi.fn(() => {
                    analyserNode = {
                        fftSize: 0,
                        frequencyBinCount: 32,
                        disconnect: vi.fn(),
                        getByteTimeDomainData: vi.fn((data) => {
                            for (let index = 0; index < data.length; index += 1) {
                                data[index] = 128 + Math.round(20 * Math.sin(index));
                            }
                        }),
                    };

                    return analyserNode;
                });
                this.createMediaStreamSource = vi.fn(() => {
                    sourceNode = {
                        connect: vi.fn(),
                        disconnect: vi.fn(),
                    };

                    return sourceNode;
                });
            }
        }

        globalThis.window = {
            SpeechRecognition: MockRecognition,
            AudioContext: MockAudioContext,
        };

        globalThis.document = documentMock;
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                language: 'en-US',
                mediaDevices: {
                    getUserMedia: vi.fn(async () => mediaStream),
                },
            },
        });

        globalThis.requestAnimationFrame = vi.fn((callback) => {
            rafQueue.push(callback);
            return rafQueue.length;
        });

        globalThis.cancelAnimationFrame = vi.fn();
    }

    beforeEach(() => {
        setActivePinia(createPinia());
        vi.useFakeTimers();
        vi.restoreAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();

        if (originalWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = originalWindow;
        }

        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }

        if (originalNavigator === undefined) {
            delete globalThis.navigator;
        } else {
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: originalNavigator,
            });
        }

        if (originalRequestAnimationFrame === undefined) {
            delete globalThis.requestAnimationFrame;
        } else {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        }

        if (originalCancelAnimationFrame === undefined) {
            delete globalThis.cancelAnimationFrame;
        } else {
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        }
    });

    it('reports unsupported when speech recognition is unavailable', () => {
        globalThis.window = {};
        globalThis.document = createDocumentMock();

        const dictation = useDictation();

        expect(dictation.isSupported).toBe(false);
    });

    it('starts recognition and cleans up audio resources on stop', async () => {
        installBrowserMocks();
        const dictation = useDictation();

        await dictation.startDictation();

        expect(globalThis.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(recognitionInstance.start).toHaveBeenCalledTimes(1);
        expect(dictation.isRecording.value).toBe(true);

        await dictation.stopDictation();

        expect(recognitionInstance.stop).toHaveBeenCalledTimes(1);
        expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
        expect(sourceNode.disconnect).toHaveBeenCalledTimes(1);
        expect(analyserNode.disconnect).toHaveBeenCalledTimes(1);
        expect(audioContextInstance.close).toHaveBeenCalledTimes(1);
        expect(dictation.isRecording.value).toBe(false);
        expect(dictation.elapsedSeconds.value).toBe(0);
    });

    it('keeps dictation running when waveform setup fails after recognition starts', async () => {
        installBrowserMocks();
        globalThis.navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('busy'));
        const dictation = useDictation();

        await dictation.startDictation();
        await Promise.resolve();

        expect(recognitionInstance.start).toHaveBeenCalledTimes(1);
        expect(dictation.isRecording.value).toBe(true);
        expect(dictation.waveformPoints.value.split(' ')).toHaveLength(8);
    });

    it('retries once without the waveform after a network error during active audio visualization', async () => {
        installBrowserMocks();
        const onError = vi.fn();
        const dictation = useDictation({ onError });

        await dictation.startDictation();
        await recognitionInstance.onerror({ error: 'network' });

        expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();

        recognitionInstance.onend();
        vi.advanceTimersByTime(150);

        expect(recognitionInstance.start).toHaveBeenCalledTimes(2);
        expect(dictation.isRecording.value).toBe(true);
    });

    it('forwards finalized speech segments without trimming', async () => {
        installBrowserMocks();
        const onFinalResult = vi.fn();
        const dictation = useDictation({ onFinalResult });

        await dictation.startDictation();

        recognitionInstance.onresult({
            resultIndex: 0,
            results: [
                { 0: { transcript: 'hello world ' }, isFinal: true },
                { 0: { transcript: 'draft' }, isFinal: false },
            ],
        });

        expect(onFinalResult).toHaveBeenCalledWith('hello world ');
        expect(dictation.interimTranscript.value).toBe('draft');
    });

    it('updates elapsed time, waveform points, and restarts on unexpected end', async () => {
        installBrowserMocks();
        const dictation = useDictation();
        const initialPoints = dictation.waveformPoints.value;

        await dictation.startDictation();
        vi.advanceTimersByTime(2000);

        expect(dictation.elapsedSeconds.value).toBe(2);

        const firstFrame = rafQueue.shift();
        firstFrame();

        expect(dictation.waveformPoints.value).not.toBe(initialPoints);
        expect(dictation.waveformPoints.value.split(' ')).toHaveLength(8);

        const yValues = dictation.waveformPoints.value
            .split(' ')
            .map((point) => Number(point.split(',')[1]));

        expect(Math.max(...yValues) - Math.min(...yValues)).toBeGreaterThan(3);

        recognitionInstance.onend();
        vi.advanceTimersByTime(150);

        expect(recognitionInstance.start).toHaveBeenCalledTimes(2);
    });

    it('stops when the tab becomes hidden', async () => {
        installBrowserMocks();
        const dictation = useDictation();

        await dictation.startDictation();
        documentMock.visibilityState = 'hidden';
        documentMock.emit('visibilitychange');
        await Promise.resolve();
        await Promise.resolve();

        expect(recognitionInstance.stop).toHaveBeenCalledTimes(1);
        expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
        expect(dictation.isRecording.value).toBe(false);
    });

    it('reports permission denied errors once per session', async () => {
        installBrowserMocks();
        const onError = vi.fn();
        const dictation = useDictation({ onError });

        await dictation.startDictation();
        await recognitionInstance.onerror({ error: 'not-allowed' });

        expect(onError).toHaveBeenCalledWith('permission-denied', expect.objectContaining({ error: 'not-allowed' }));
    });
});