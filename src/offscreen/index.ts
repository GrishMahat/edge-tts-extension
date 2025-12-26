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
}

// Create TTS player with callbacks to send state updates
const player = new TTSPlayer({
  onLoading: () => sendPlaybackState('loading'),
  onPlaying: () => sendPlaybackState('playing'),
  onPaused: () => sendPlaybackState('paused'),
  onStopped: () => sendPlaybackState('stopped'),
  onError: (error) => sendPlaybackState('error', error),
});

function sendPlaybackState(state: 'playing' | 'paused' | 'stopped' | 'loading' | 'error', error?: string) {
  browser.runtime.sendMessage({
    action: 'playbackState',
    state,
    error,
  }).catch(() => {
    // Ignore errors if no listeners
  });
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
        player.play(message.text, message.settings).catch((error) => {
          console.error('Offscreen TTS initialization error:', error);
        });
      }
      break;

    case 'offscreen:togglePlayback':
      player.togglePause();
      break;

    case 'offscreen:stopPlayback':
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
