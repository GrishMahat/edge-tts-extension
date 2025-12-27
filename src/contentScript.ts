import browser from 'webextension-polyfill';
import './content-styles.css';
import {
  createControlPanel,
  updatePanelContent,
} from "./components/controlPanel";
import { circlePause, circlePlay } from './lib/svgs';
import { extractTextFromSelection, extractTextFromSelectionSimple } from './utils/textExtraction';
import { TTSPlayer } from './utils/ttsPlayer';

let controlPanel: HTMLElement | null = null;
let isPlaying = false;
let usingOffscreenAudio = false;

// Create TTS player with callbacks for UI updates
const player = new TTSPlayer({
  onLoading: () => {
    // Panel already created in initTTS
  },
  onPlaying: () => {
    isPlaying = true;
    if (controlPanel) {
      updatePanelContent(controlPanel, false);
    }
    updatePlayPauseButton();
  },
  onPaused: () => {
    isPlaying = false;
    updatePlayPauseButton();
  },
  onStopped: () => {
    isPlaying = false;
    updatePlayPauseButton();
    removeControlPanel();
  },
  onError: (error) => {
    // Check if this is a CSP error - if so, try offscreen fallback silently
    if (error && (error.includes('URL safety check') || error.includes('CSP') || error.includes('Content Security Policy') || error.includes('MEDIA_ERR_SRC_NOT_SUPPORTED'))) {
      // Trigger fallback asynchronously - use the pending text/settings stored in initTTS
      handleCSPFallback();
      return; // Don't remove panel yet - let the fallback handle it
    }
    console.error('TTS playback error:', error);
    if (controlPanel) {
      updatePanelContent(controlPanel, false, error || "Unknown playback error");
    } else {
      removeControlPanel();
    }
  },
});

// Track pending fallback text for CSP retry
let pendingFallbackText: string | null = null;
let pendingFallbackSettings: any = null;

// Function to handle CSP fallback from error callback
function handleCSPFallback(): void {
  if (pendingFallbackText) {
    initTTSViaOffscreen(pendingFallbackText, pendingFallbackSettings || {})
      .catch((err) => {
        console.error('Offscreen fallback failed:', err);
        removeControlPanel();
      });
    pendingFallbackText = null;
    pendingFallbackSettings = null;
  } else {
    console.warn('No pending text for CSP fallback');
    removeControlPanel();
  }
}

// Make these functions available to the control panel
(window as any).togglePause = togglePause;
(window as any).stopPlayback = stopPlayback;

export async function initTTS(text: string, useOffscreen = false): Promise<void> {
  player.cleanup();
  removeControlPanel();
  pendingFallbackText = null;
  pendingFallbackSettings = null;

  try {
    const settings = await browser.storage.sync.get({
      voiceName: "en-US-ChristopherNeural",
      customVoice: "",
      speed: 1.2,
    });

    // If CSP issues detected or forced offscreen, use offscreen document
    if (useOffscreen) {
      await initTTSViaOffscreen(text, settings);
      return;
    }

    // Store settings for potential fallback
    pendingFallbackText = text;
    pendingFallbackSettings = settings;

    // Create control panel in loading state
    controlPanel = await createControlPanel(true);

    // Setup media session handlers
    try {
      navigator.mediaSession.setActionHandler("play", () => player.togglePause());
      navigator.mediaSession.setActionHandler("pause", () => player.togglePause());
      navigator.mediaSession.setActionHandler("stop", () => stopPlayback());
    } catch (e) {
      // Ignore if mediaSession is not supported
    }

    await player.play(text, {
      voiceName: settings.voiceName as string,
      customVoice: settings.customVoice as string,
      speed: settings.speed as number,
    });
  } catch (error: any) {
    console.error("TTS Error:", error);
    
    // Check if this is a CSP-related error
    const errorMsg = error?.message || String(error);
    if (errorMsg.includes('URL safety check') || errorMsg.includes('CSP') || errorMsg.includes('Content Security Policy') || errorMsg.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
      await tryOffscreenFallback();
      return;
    }
    
    // removeControlPanel();
    // throw error;
    if (controlPanel) {
      updatePanelContent(controlPanel, false, String(errorMsg));
    } else {
      removeControlPanel();
    }
  }
}

/**
 * Fallback to offscreen document for CSP-blocked pages
 */
async function tryOffscreenFallback(): Promise<void> {
  if (!pendingFallbackText) {
    console.error('No pending text for offscreen fallback');
    removeControlPanel();
    return;
  }

  await initTTSViaOffscreen(pendingFallbackText, pendingFallbackSettings || {});
  pendingFallbackText = null;
  pendingFallbackSettings = null;
}

/**
 * Play TTS via offscreen document (bypasses page CSP)
 */
async function initTTSViaOffscreen(text: string, settings: any): Promise<void> {
  usingOffscreenAudio = true;
  
  // Show loading UI immediately
  if (!controlPanel) {
    controlPanel = await createControlPanel(true);
  }

  // Request offscreen playback through background script
  try {
    const response = await browser.runtime.sendMessage({
      action: 'requestOffscreenPlayback',
      text,
      settings: {
        voiceName: settings.voiceName || 'en-US-ChristopherNeural',
        customVoice: settings.customVoice || '',
        speed: settings.speed || 1.2,
      },
    });
  } catch (error) {
    console.error('Content: Failed to request offscreen playback:', error);
    removeControlPanel();
    usingOffscreenAudio = false;
  }
}

function updatePlayPauseButton() {
  const pauseButton = document.querySelector("#tts-pause");
  if (pauseButton) {
    const buttonText = isPlaying ? "Pause" : "Resume";
    pauseButton.innerHTML = `
      ${isPlaying ? circlePause : circlePlay}
      <span>${buttonText}</span>
    `;
  }
}

function togglePause() {
  if (usingOffscreenAudio) {
    browser.runtime.sendMessage({ action: 'offscreen:togglePlayback' }).catch(() => {});
    return;
  }
  player.togglePause();
}

function stopPlayback() {
  if (usingOffscreenAudio) {
    browser.runtime.sendMessage({ action: 'offscreen:stopPlayback' }).catch(() => {});
    usingOffscreenAudio = false;
    removeControlPanel();
    return;
  }
  player.stop();
}

function removeControlPanel() {
  if (controlPanel) {
    const buttons = controlPanel.querySelectorAll('button');
    buttons.forEach((button: HTMLButtonElement) => {
      const newButton = button.cloneNode(true);
      button.parentNode?.replaceChild(newButton, button);
    });

    if (controlPanel.parentNode) {
      controlPanel.parentNode.removeChild(controlPanel);
    }
  }
  controlPanel = null;
}

// Define the message structure
interface ExtensionMessage {
  action: string;
  text?: string;
  state?: 'playing' | 'paused' | 'stopped' | 'loading' | 'error';
  error?: string;
}

// Message listener
browser.runtime.onMessage.addListener(function handleMessage(
  request: ExtensionMessage,
  sender,
  sendResponse
) {
  // Handle ping to check if content script is loaded
  if (request.action === "ping") {
    sendResponse({ pong: true });
    return true;
  }
  
  if (request.action === "stopPlayback") {
    if (usingOffscreenAudio) {
      browser.runtime.sendMessage({ action: 'offscreen:stopPlayback' }).catch(() => {});
      removeControlPanel();
    } else {
      stopPlayback();
    }
  }
  else if (request.action === "togglePlayback") {
    if (usingOffscreenAudio) {
      browser.runtime.sendMessage({ action: 'offscreen:togglePlayback' }).catch(() => {});
    } else {
      togglePause();
    }
  }
  else if (request.action === "readText") {
    initTTS(request.text!).catch((error) => {
      // console.error("TTS initialization error:", error);
    });
  }
  else if (request.action === 'readPage') {
    const pageContent = document.body.innerText;
    if (pageContent && pageContent.trim() !== '') {
      initTTS(pageContent).catch((error) => {
        // console.error("TTS initialization error:", error);
      });
    } else {
      console.warn('The page content is empty.');
    }
  }
  else if (request.action === 'readFromHere' && request.text) {
    try {
      let textToRead = extractTextFromSelection(request.text);
      if (!textToRead || textToRead.trim().length === 0) {
        textToRead = extractTextFromSelectionSimple(request.text);
      }
      if (textToRead && textToRead.trim() !== '') {
        initTTS(textToRead).catch((error) => {
          // console.error("TTS initialization error:", error);
        });
      } else {
        console.warn('No text found from selection point.');
        initTTS(request.text).catch((error) => {
          // console.error("TTS initialization error:", error);
        });
      }
    } catch (error) {
      console.error("Error extracting text from selection:", error);
      initTTS(request.text).catch((error) => {
        // console.error("TTS initialization error:", error);
      });
    }
  }
  else if (request.action === 'showPlaybackUI') {
    usingOffscreenAudio = true;
    showOffscreenUI();
  }
  else if (request.action === 'updatePlaybackState') {
    updateOffscreenPlaybackState(request.state, request.error);
  }
  else if (request.action === 'extractTextFromHere' && request.text) {
    try {
      let textToRead = extractTextFromSelection(request.text);
      if (!textToRead || textToRead.trim().length === 0) {
        textToRead = extractTextFromSelectionSimple(request.text);
      }
      if (!textToRead || textToRead.trim().length === 0) {
        textToRead = request.text;
      }
      sendResponse({ text: textToRead });
    } catch (error) {
      console.error("Error extracting text:", error);
      sendResponse({ text: request.text });
    }
    return true;
  }
} as browser.Runtime.OnMessageListener);

async function showOffscreenUI() {
  player.cleanup();
  removeControlPanel();
  controlPanel = await createControlPanel(true);
}

function updateOffscreenPlaybackState(state?: string, error?: string) {
  if (!controlPanel && state !== 'stopped') {
    createControlPanel(state === 'loading').then((panel) => {
      controlPanel = panel;
      updateUIForState(state);
    });
    return;
  }
  updateUIForState(state);
}

function updateUIForState(state?: string) {
  switch (state) {
    case 'loading':
      if (controlPanel) {
        updatePanelContent(controlPanel, true);
      }
      break;
    case 'playing':
      isPlaying = true;
      if (controlPanel) {
        updatePanelContent(controlPanel, false);
      }
      updatePlayPauseButton();
      break;
    case 'paused':
      isPlaying = false;
      updatePlayPauseButton();
      break;
    case 'stopped':
      isPlaying = false;
      usingOffscreenAudio = false;
      removeControlPanel();
      break;
    case 'error':
      isPlaying = false;
      usingOffscreenAudio = false;
      if (controlPanel) {
        updatePanelContent(controlPanel, false, 'Offscreen playback error');
      } else {
        removeControlPanel();
      }
      break;
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { action, text } = event.data || {};
  if (action === 'triggerTTS' && typeof text === 'string') {
    initTTS(text).catch((err) => console.error('initTTS error:', err));
  }
});

window.addEventListener('beforeunload', () => {
  player.cleanup();
});
