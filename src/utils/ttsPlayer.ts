/**
 * Shared TTS Audio Player module.
 * Used by both contentScript (fallback mode) and offscreen document.
 */
import { BrowserCommunicate, BrowserCommunicateOptions } from './browserCommunicate';
import { isFirefox } from './browserDetection';

export interface TTSPlayerCallbacks {
  onLoading?: () => void;
  onPlaying?: () => void;
  onPaused?: () => void;
  onStopped?: () => void;
  onError?: (error: string) => void;
}

export interface TTSSettings {
  voiceName?: string;
  customVoice?: string;
  speed?: number;
}

/**
 * Shared TTS player that handles audio streaming and playback.
 * Can be used in both content script and offscreen document contexts.
 */
export class TTSPlayer {
  private audioElement: HTMLAudioElement | null = null;
  private isPlaying = false;
  private currentTTSDeactivate: (() => void) | null = null;
  private callbacks: TTSPlayerCallbacks;

  constructor(callbacks: TTSPlayerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Initialize and play TTS for the given text.
   */
  async play(text: string, settings?: TTSSettings): Promise<void> {
    // Deactivate any previous TTS instance
    if (this.currentTTSDeactivate) {
      this.currentTTSDeactivate();
    }

    this.cleanup();

    try {
      this.callbacks.onLoading?.();

      const voiceName = settings?.customVoice || settings?.voiceName || 'en-US-ChristopherNeural';
      const speed = settings?.speed || 1.2;

      // Convert speed setting to TTS format
      const speedPercent = Math.round((speed - 1) * 100);
      const rateString = speedPercent >= 0 ? `+${speedPercent}%` : `${speedPercent}%`;

      const browserCommunicateOptions: BrowserCommunicateOptions = {
        voice: voiceName,
        rate: rateString,
        connectionTimeout: 10000,
      };

      const communicate = new BrowserCommunicate(text, browserCommunicateOptions);

      return new Promise((resolve, reject) => {
        const mediaSource = new MediaSource();
        let sourceBuffer: SourceBuffer;
        const chunks: Uint8Array[] = [];
        let isFirstChunk = true;
        let isActive = true;

        this.currentTTSDeactivate = () => {
          isActive = false;
        };

        if (!this.audioElement) {
          this.audioElement = new Audio();
          this.audioElement.muted = true;
          this.audioElement.src = URL.createObjectURL(mediaSource);

          this.audioElement.onplay = () => {
            if (this.audioElement) {
              this.audioElement.muted = false;
            }
            this.isPlaying = true;
            this.callbacks.onPlaying?.();
          };

          this.audioElement.onpause = () => {
            this.isPlaying = false;
            this.callbacks.onPaused?.();
          };

          this.audioElement.onended = () => {
            this.isPlaying = false;
            this.callbacks.onStopped?.();
            this.cleanup();
          };

          this.audioElement.onerror = (event) => {
            const errorDetails = {
              errorCode: this.audioElement?.error?.code,
              errorMessage: this.audioElement?.error?.message,
              errorType: this.audioElement?.error?.code === 1 ? 'MEDIA_ERR_ABORTED' :
                         this.audioElement?.error?.code === 2 ? 'MEDIA_ERR_NETWORK' :
                         this.audioElement?.error?.code === 3 ? 'MEDIA_ERR_DECODE' :
                         this.audioElement?.error?.code === 4 ? 'MEDIA_ERR_SRC_NOT_SUPPORTED' : 'UNKNOWN',
            };
            console.error('Audio playback error:', errorDetails);
            this.callbacks.onError?.(this.audioElement?.error?.message || 'Audio playback error');
            this.cleanup();
          };
        }

        const appendNextChunk = () => {
          if (!isActive || !sourceBuffer || mediaSource.readyState !== 'open') {
            return;
          }

          if (chunks.length > 0 && !sourceBuffer.updating) {
            try {
              const chunk = chunks.shift();
              if (chunk) {
                const safeChunk = new Uint8Array(chunk.length);
                safeChunk.set(chunk);
                sourceBuffer.appendBuffer(safeChunk);

                if (isFirstChunk) {
                  if (isFirefox()) {
                    setTimeout(() => {
                      this.audioElement?.play().catch((err) => {
                        console.warn('Firefox autoplay workaround failed:', err);
                      });
                    }, 0);
                  } else {
                    this.audioElement?.play().catch((err) => {
                      console.warn('Audio playback failed:', err);
                    });
                  }
                  isFirstChunk = false;
                }
              }
            } catch (err) {
              console.error('appendNextChunk error:', err);
              chunks.shift();
              if (isActive) {
                setTimeout(appendNextChunk, 100);
              }
            }
          }
        };

        mediaSource.addEventListener('sourceopen', () => {
          try {
            const mimeType = isFirefox()
              ? 'audio/webm; codecs="opus"'
              : 'audio/mpeg';
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBuffer.addEventListener('updateend', appendNextChunk);

            (async () => {
              try {
                let streamEnded = false;

                for await (const chunk of communicate.stream()) {
                  if (!isActive) {
                    streamEnded = true;
                    return;
                  }

                  if (chunk.type === 'audio' && chunk.data) {
                    const cloned = new Uint8Array(chunk.data.byteLength);
                    cloned.set(chunk.data);
                    chunks.push(cloned);
                    appendNextChunk();
                  }
                }

                streamEnded = true;

                const checkAndEndStream = () => {
                  if (!isActive) return;

                  if (streamEnded && chunks.length === 0 && !sourceBuffer.updating) {
                    try {
                      if (mediaSource.readyState === 'open') {
                        mediaSource.endOfStream();
                      }
                      resolve(void 0);
                    } catch (err) {
                      resolve(void 0);
                    }
                  } else {
                    setTimeout(checkAndEndStream, 100);
                  }
                };
                checkAndEndStream();
              } catch (error) {
                console.error('TTS streaming error:', error);
                this.callbacks.onError?.((error as Error).message || 'TTS streaming error');
                reject(error);
              }
            })();
          } catch (error) {
            reject(error);
          }
        });
      });
    } catch (error) {
      console.error("TTS Error:", error);
      this.callbacks.onError?.((error as Error).message || 'TTS initialization error');
      this.cleanup();
      throw error;
    }
  }

  togglePause(): void {
    if (!this.audioElement) return;
    if (this.audioElement.paused) {
      this.audioElement.play();
    } else {
      this.audioElement.pause();
    }
  }

  stop(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    }
    this.cleanup();
    this.callbacks.onStopped?.();
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  hasAudio(): boolean {
    return this.audioElement !== null;
  }

  cleanup(): void {
    if (this.currentTTSDeactivate) {
      this.currentTTSDeactivate();
      this.currentTTSDeactivate = null;
    }

    if (this.audioElement) {
      this.audioElement.onplay = null;
      this.audioElement.onpause = null;
      this.audioElement.onended = null;
      this.audioElement.onerror = null;

      const oldSrc = this.audioElement.src;
      this.audioElement.pause();
      this.audioElement.src = "";
      this.audioElement.load();

      if (oldSrc && oldSrc.startsWith('blob:')) {
        URL.revokeObjectURL(oldSrc);
      }
    }
    this.audioElement = null;
    this.isPlaying = false;
  }
}
