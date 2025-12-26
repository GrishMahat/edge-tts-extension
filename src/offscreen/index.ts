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
  }).catch(() => {
    // Ignore errors if no listeners
  });
}

function startPlaybackTimeout() {
  clearPlaybackTimeout();
  playbackTimeoutId = setTimeout(() => {
    console.warn('TTS playback timeout - no audio playing after 30 seconds');
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
  onLoading: () => sendPlaybackState('loading'),
  onPlaying: () => {
    clearPlaybackTimeout();
    sendPlaybackState('playing');
  },
  onPaused: () => sendPlaybackState('paused'),
  onStopped: () => {
    clearPlaybackTimeout();
    originatingTabId = null;
    sendPlaybackState('stopped');
  },
  onError: (error) => {
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
  console.log('Offscreen received message:', message.action);

  switch (message.action) {
    case 'offscreen:readText':
      if (message.text) {
        originatingTabId = message.originatingTabId || null;
        sendPlaybackState('loading'); // Immediately send loading state
        startPlaybackTimeout(); // Start timeout
        player.play(message.text, message.settings).catch((error) => {
          console.error('Offscreen TTS initialization error:', error);
          clearPlaybackTimeout();
          // Send error state to dismiss the loading UI
          sendPlaybackState('error', error?.message || 'TTS initialization failed');
        });
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
      sendResponse({
        isPlaying: player.getIsPlaying(),
        hasAudio: player.hasAudio(),
      });
      return true;

    default:
      break;
  }
} as browser.Runtime.OnMessageListener);

console.log('Offscreen audio player initialized');

