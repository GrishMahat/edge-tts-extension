/**
 * Offscreen document for audio playback.
 * This runs in the extension's context, bypassing page CSP restrictions.
 */
import browser from 'webextension-polyfill';
import { BrowserCommunicate, BrowserCommunicateOptions } from '../utils/browserCommunicate';
import { isFirefox } from '../utils/browserDetection';

let audioElement: HTMLAudioElement | null = null;
let isPlaying = false;
let currentTTSDeactivate: (() => void) | null = null;

// Message types for communication
interface OffscreenMessage {
  action: string;
  text?: string;
  settings?: {
    voiceName: string;
    customVoice: string;
    speed: number;
  };
}

interface PlaybackStateMessage {
  action: 'playbackState';
  state: 'playing' | 'paused' | 'stopped' | 'loading' | 'error';
  error?: string;
}

function sendPlaybackState(state: PlaybackStateMessage['state'], error?: string) {
  browser.runtime.sendMessage({
    action: 'playbackState',
    state,
    error,
  } as PlaybackStateMessage).catch(() => {
    // Ignore errors if no listeners
  });
}

async function initTTS(text: string, settings: OffscreenMessage['settings']): Promise<void> {
  // Deactivate any previous TTS instance
  if (currentTTSDeactivate) {
    currentTTSDeactivate();
  }

  cleanup();

  try {
    sendPlaybackState('loading');

    const voiceName = settings?.customVoice || settings?.voiceName || 'en-US-ChristopherNeural';
    const speed = settings?.speed || 1.2;

    const speedPercent = Math.round((speed - 1) * 100);
    const rateString = speedPercent >= 0 ? `+${speedPercent}%` : `${speedPercent}%`;

    const browserCommunicateOptions: BrowserCommunicateOptions = {
      voice: voiceName,
      rate: rateString,
      connectionTimeout: 10000, // 10 seconds
    };

    // Create BrowserCommunicate instance
    const communicate = new BrowserCommunicate(text, browserCommunicateOptions);

    return new Promise((resolve, reject) => {
      const mediaSource = new MediaSource();
      let sourceBuffer: SourceBuffer;
      const chunks: Uint8Array[] = [];
      let isFirstChunk = true;
      let isActive = true; // Track if this TTS instance is still active

      // Set up the deactivation function for this instance
      currentTTSDeactivate = () => {
        isActive = false;
      };

      if (!audioElement) {
        audioElement = new Audio();
        audioElement.muted = true; // allow autoplay
        audioElement.src = URL.createObjectURL(mediaSource);

        audioElement.onplay = () => {
          if (audioElement) {
            audioElement.muted = false;
          }
          isPlaying = true;
          sendPlaybackState('playing');
        };

        audioElement.onpause = () => {
          isPlaying = false;
          sendPlaybackState('paused');
        };

        audioElement.onended = () => {
          isPlaying = false;
          sendPlaybackState('stopped');
          cleanup();
        };

        audioElement.onerror = (event) => {
          const errorDetails = {
            event: event,
            mediaError: audioElement?.error,
            errorCode: audioElement?.error?.code,
            errorMessage: audioElement?.error?.message,
            errorType: audioElement?.error?.code === 1 ? 'MEDIA_ERR_ABORTED' :
                       audioElement?.error?.code === 2 ? 'MEDIA_ERR_NETWORK' :
                       audioElement?.error?.code === 3 ? 'MEDIA_ERR_DECODE' :
                       audioElement?.error?.code === 4 ? 'MEDIA_ERR_SRC_NOT_SUPPORTED' : 'UNKNOWN',
          };
          console.error('Offscreen audio playback error:', errorDetails);
          sendPlaybackState('error', audioElement?.error?.message || 'Audio playback error');
          cleanup();
        };
      }

      const appendNextChunk = () => {
        // Check if this TTS instance is still active and sourceBuffer exists
        if (!isActive || !sourceBuffer || mediaSource.readyState !== 'open') {
          return;
        }

        if (chunks.length > 0 && !sourceBuffer.updating) {
          try {
            const chunk = chunks.shift();
            if (chunk) {
              // SAFELY COPY to avoid DOMException from detached buffer
              const safeChunk = new Uint8Array(chunk.length);
              safeChunk.set(chunk);
              sourceBuffer.appendBuffer(safeChunk);

              if (isFirstChunk) {
                if (isFirefox()) {
                  setTimeout(() => {
                    audioElement?.play().catch((err) => {
                      console.warn('Firefox autoplay workaround failed:', err);
                    });
                  }, 0);
                } else {
                  audioElement?.play().catch((err) => {
                    console.warn('Audio playback failed:', err);
                  });
                }
                isFirstChunk = false;
              }
            }
          } catch (err) {
            console.error('appendNextChunk error:', err, 'chunk length:', chunks[0]?.length);
            chunks.shift();

            if (isActive) {
              setTimeout(appendNextChunk, 100);
            }
          }
        }
      };

      mediaSource.addEventListener('sourceopen', () => {
        try {
          // Use WebM format for Firefox, MP3 for Chrome
          const mimeType = isFirefox()
            ? 'audio/webm; codecs="opus"'
            : 'audio/mpeg';
          sourceBuffer = mediaSource.addSourceBuffer(mimeType);
          sourceBuffer.addEventListener('updateend', appendNextChunk);

          // Start the chunked streaming process
          (async () => {
            try {
              let streamEnded = false;

              for await (const chunk of communicate.stream()) {
                if (!isActive) {
                  streamEnded = true;
                  return; // Stop if this instance is no longer active
                }

                if (chunk.type === 'audio' && chunk.data) {
                  // Clone data before using it
                  const cloned = new Uint8Array(chunk.data.byteLength);
                  cloned.set(chunk.data);
                  chunks.push(cloned);
                  appendNextChunk();
                }
              }

              streamEnded = true;

              // All chunks processed, end the stream
              const checkAndEndStream = () => {
                if (!isActive) {
                  return;
                }

                if (streamEnded && chunks.length === 0 && !sourceBuffer.updating) {
                  try {
                    if (mediaSource.readyState === 'open') {
                      mediaSource.endOfStream();
                      resolve(void 0);
                    } else {
                      resolve(void 0);
                    }
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
              sendPlaybackState('error', (error as Error).message || 'TTS streaming error');
              reject(error);
            }
          })();
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    console.error("Offscreen TTS Error:", error);
    sendPlaybackState('error', (error as Error).message || 'TTS initialization error');
    cleanup();
    throw error;
  }
}

function togglePause() {
  if (!audioElement) return;

  if (audioElement.paused) {
    audioElement.play();
  } else {
    audioElement.pause();
  }
}

function stopPlayback() {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
  }
  cleanup();
  sendPlaybackState('stopped');
}

function cleanup() {
  // Deactivate current TTS instance if exists
  if (currentTTSDeactivate) {
    currentTTSDeactivate();
    currentTTSDeactivate = null;
  }

  if (audioElement) {
    audioElement.onplay = null;
    audioElement.onpause = null;
    audioElement.onended = null;
    audioElement.onerror = null;

    const oldSrc = audioElement.src;
    audioElement.pause();
    audioElement.src = "";
    audioElement.load();

    if (oldSrc && oldSrc.startsWith('blob:')) {
      URL.revokeObjectURL(oldSrc);
    }
  }
  audioElement = null;
  isPlaying = false;
}

// Listen for messages from background script
browser.runtime.onMessage.addListener(function handleMessage(
  message: OffscreenMessage,
  sender,
  sendResponse
) {
  console.log('Offscreen received message:', message.action);

  switch (message.action) {
    case 'offscreen:readText':
      if (message.text) {
        initTTS(message.text, message.settings).catch((error) => {
          console.error('Offscreen TTS initialization error:', error);
        });
      }
      break;

    case 'offscreen:togglePlayback':
      togglePause();
      break;

    case 'offscreen:stopPlayback':
      stopPlayback();
      break;

    case 'offscreen:getState':
      sendResponse({
        isPlaying,
        hasAudio: audioElement !== null,
      });
      return true; // Keep message channel open for async response

    default:
      // Ignore unknown messages
      break;
  }
} as browser.Runtime.OnMessageListener);

console.log('Offscreen audio player initialized');
