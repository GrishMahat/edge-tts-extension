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
  console.log('[Offscreen] Sending playback state:', state, error || '');
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
  console.log('[Offscreen] Starting playback timeout (30s)');
  playbackTimeoutId = setTimeout(() => {
    console.warn('[Offscreen] TTS playback timeout - no audio playing after 30 seconds');
    sendPlaybackState('error', 'TTS generation timed out. Please try again.');
    player.stop();
  }, PLAYBACK_TIMEOUT);
}

function clearPlaybackTimeout() {
  if (playbackTimeoutId) {
    console.log('[Offscreen] Clearing playback timeout');
    clearTimeout(playbackTimeoutId);
    playbackTimeoutId = null;
  }
}

// Create TTS player with callbacks to send state updates
const player = new TTSPlayer({
  onLoading: () => {
    console.log('[Offscreen] Player callback: onLoading');
    sendPlaybackState('loading');
  },
  onPlaying: () => {
    console.log('[Offscreen] Player callback: onPlaying');
    clearPlaybackTimeout();
    sendPlaybackState('playing');
  },
  onPaused: () => {
    console.log('[Offscreen] Player callback: onPaused');
    sendPlaybackState('paused');
  },
  onStopped: () => {
    console.log('[Offscreen] Player callback: onStopped');
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
  console.log('[Offscreen] Received message:', message.action, 'text length:', message.text?.length);

  switch (message.action) {
    case 'offscreen:readText':
      console.log('[Offscreen] Processing readText request');
      if (message.text) {
        originatingTabId = message.originatingTabId || null;
        console.log('[Offscreen] Sending loading state, originatingTabId:', originatingTabId);
        sendPlaybackState('loading');
        startPlaybackTimeout();
        console.log('[Offscreen] Starting player.play()');
        player.play(message.text, message.settings)
          .then(() => {
            console.log('[Offscreen] player.play() promise resolved');
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
      console.log('[Offscreen] Toggling playback');
      player.togglePause();
      break;

    case 'offscreen:stopPlayback':
      console.log('[Offscreen] Stopping playback');
      clearPlaybackTimeout();
      player.stop();
      break;

    case 'offscreen:getState':
      const state = {
        isPlaying: player.getIsPlaying(),
        hasAudio: player.hasAudio(),
      };
      console.log('[Offscreen] getState:', state);
      sendResponse(state);
      return true;

    default:
      console.log('[Offscreen] Unknown action:', message.action);
      break;
  }
} as browser.Runtime.OnMessageListener);

console.log('[Offscreen] Audio player initialized and ready');
