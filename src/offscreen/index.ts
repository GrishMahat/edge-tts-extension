/**
 * Offscreen document for audio playback.
 * This runs in the extension's context, bypassing page CSP restrictions.
 */
import browser from 'webextension-polyfill';
import { TTSPlayer, TTSSettings } from '../utils/ttsPlayer';

// Message types for communication
interface OffscreenMessage {
  action: string;
  text?: string;
  settings?: TTSSettings;
  originatingTabId?: number;
}

// Track originating tab for state updates
let originatingTabId: number | null = null;
let playbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
const PLAYBACK_TIMEOUT = 30000; // 30 seconds

function sendPlaybackState(state: 'playing' | 'paused' | 'stopped' | 'loading' | 'error', error?: string) {
  browser.runtime.sendMessage({
    action: 'playbackState',
    state,
    error,
    originatingTabId,
  }).catch((err) => {
    console.warn('[Offscreen] Failed to send playback state:', err);
  });
}

function startPlaybackTimeout() {
  clearPlaybackTimeout();
  playbackTimeoutId = setTimeout(() => {
    console.warn('[Offscreen] TTS playback timeout - no audio playing after 30 seconds');
    sendPlaybackState('error', 'TTS generation timed out. Please try again.');
    player.stop();
  }, PLAYBACK_TIMEOUT);
}

function clearPlaybackTimeout() {
  if (playbackTimeoutId) {
    clearTimeout(playbackTimeoutId);
    playbackTimeoutId = null;
  }
}

// Create TTS player with callbacks to send state updates
const player = new TTSPlayer({
  onLoading: () => {
    sendPlaybackState('loading');
  },
  onPlaying: () => {
    clearPlaybackTimeout();
    sendPlaybackState('playing');
  },
  onPaused: () => {
    sendPlaybackState('paused');
  },
  onStopped: () => {
    clearPlaybackTimeout();
    originatingTabId = null;
    sendPlaybackState('stopped');
  },
  onError: (error) => {
    console.error('[Offscreen] Player callback: onError:', error);
    clearPlaybackTimeout();
    originatingTabId = null;
    sendPlaybackState('error', error);
  },
});

// Listen for messages from background script
browser.runtime.onMessage.addListener(function handleMessage(
  message: OffscreenMessage,
  sender,
  sendResponse
) {

  switch (message.action) {
    case 'offscreen:readText':
      if (message.text) {
        originatingTabId = message.originatingTabId || null;
        sendPlaybackState('loading');
        startPlaybackTimeout();
        player.play(message.text, message.settings)
          .then(() => {
          })
          .catch((error) => {
            console.error('[Offscreen] player.play() error:', error);
            clearPlaybackTimeout();
            sendPlaybackState('error', error?.message || 'TTS initialization failed');
          });
      } else {
        console.warn('[Offscreen] readText called with no text');
      }
      break;

    case 'offscreen:togglePlayback':
      player.togglePause();
      break;

    case 'offscreen:stopPlayback':
      clearPlaybackTimeout();
      player.stop();
      break;

    case 'offscreen:getState':
      const state = {
        isPlaying: player.getIsPlaying(),
        hasAudio: player.hasAudio(),
      };
      sendResponse(state);
      return true;

    default:
      break;
  }
} as browser.Runtime.OnMessageListener);
