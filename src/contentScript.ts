import browser from 'webextension-polyfill';
import './content-styles.css';
import {
  createControlPanel,
  updatePanelContent,
} from "./components/controlPanel";
import { circlePause, circlePlay } from './lib/svgs';
import { extractTextFromSelection, extractTextFromSelectionSimple, ExtractedText } from './utils/textExtraction';
import { TTSPlayer } from './utils/ttsPlayer';
import { WordMatcher } from './utils/wordMatcher';

let matcher: WordMatcher | null = null;

let controlPanel: HTMLElement | null = null;
let isPlaying = false;
let usingOffscreenAudio = false;
let currentSettings: any = {};

// Track highlighted text for sentence granularity
let lastHighlightedSentence: string | null = null;
let accumulatedWords: string[] = [];

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
    if (matcher) {
      matcher.clear();
      matcher = null;
    }
    // Reset tracking
    lastHighlightedSentence = null;
    accumulatedWords = [];
  },
  onHighlight: (data) => {
    if (matcher && currentSettings.enableHighlighting) {
      const mode = currentSettings.highlightGranularity || 'word';
      
      let shouldHighlight = true;
      
      if (mode === 'sentence') {
        const lang = currentSettings.voiceName ? currentSettings.voiceName.split('-').slice(0, 2).join('-') : 'en-US';
        // @ts-ignore - Intl.Segmenter is new
        const segmenter = new (Intl as any).Segmenter(lang, { granularity: 'sentence' });
        
        // We need to check if adding the new word starts a new sentence segment
        // vs extending the current one
        if (accumulatedWords.length > 0) {
           const prevText = accumulatedWords.join(' ');
           const combinedText = prevText + ' ' + data.text;
           
           // Check segments of the combined text
           // If the split point between prevText and data.text coincides with a segment boundary,
           // then we should highlight.
           
           // Optimization: We could be smarter/faster, but for typical paragraph lengths this is fine
           const segments = Array.from(segmenter.segment(combinedText));
           const splitIndex = prevText.length;
           
           // Find if any segment starts exactly at (or casually around) the split boundary
           // The segmenter might include the space in the previous segment or start the next one
           // Usually: "Hello. World" -> "Hello. " (len 7), "World" (start 7)
           
           const isBoundary = segments.some((seg: any) => {
               // A new segment starts roughly where our new word starts
               // Allow for a generic space delta (len 1)
               return Math.abs(seg.index - splitIndex) <= 2 && seg.index > 0;
           });
           
           shouldHighlight = isBoundary;
        }
        accumulatedWords.push(data.text);
      }
      // For 'word' mode, always highlight (shouldHighlight stays true)
      
      if (!shouldHighlight) {
        // Still advance the matcher position even if we don't update the highlight
        matcher.advancePosition(data.text);
        return; // Skip this word, keep current highlight
      }
      
      const node = matcher.highlightWord(data.text, mode);

      if (currentSettings.autoScroll && node) {
          // Robust auto-scroll implementation
          try {
             const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
             if (element) {
                const rect = element.getBoundingClientRect();
                const isInViewport = (
                    rect.top >= 0 &&
                    rect.left >= 0 &&
                    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
                );

                if (!isInViewport) {
                    element.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                        inline: 'nearest'
                    });
                }
             }
          } catch(e) {
             // Ignore scroll errors
          }
      }
    }
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
      pitch: "+0Hz",
      volume: "+0%",
      enableHighlighting: false,
      highlightColor: "#ffe42e",
      autoScroll: false,
    });

    // Apply highlight color
    if (settings.highlightColor) {
      document.documentElement.style.setProperty('--etts-highlight-bg', settings.highlightColor as string);
    }
    
    // Store for usage in callbacks
    currentSettings = settings;

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
      pitch: settings.pitch as string,
      volume: settings.volume as string,
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
  
  // Initialize matcher from current selection BEFORE it gets lost
  if (settings.enableHighlighting) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      matcher = new WordMatcher(range.startContainer, range.startOffset);
      // Clear selection so only TTS highlight is visible
      selection.removeAllRanges();
    } else {
      // Fallback: search from start of body
      matcher = new WordMatcher(document.body, 0);
    }
    accumulatedWords = [];
  }
  
  // Store settings for the highlight handler
  currentSettings = { ...currentSettings, ...settings };
  
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
        pitch: settings.pitch || '+0Hz',
        volume: settings.volume || '+0%',
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
    // Attempt to initialize matcher from selection if it matches the text
    // This ensures we highlight the correct occurrence if there are duplicates
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.toString().includes(request.text!.substring(0, 20))) {
         const range = selection.getRangeAt(0);
         matcher = new WordMatcher(range.startContainer || document.body, range.startOffset);
    } else {
        // Fallback: search from start of body (might pick first occurrence)
        matcher = new WordMatcher(document.body, 0);
    }

    // Clear the selection if highlighting is enabled so only the TTS highlight is visible
    if (currentSettings.enableHighlighting && selection) {
      selection.removeAllRanges();
    }
    
    // Reset accumulated words for sentence mode
    accumulatedWords = [];

    initTTS(request.text!).catch((error) => {
      // console.error("TTS initialization error:", error);
    });
  }
  else if (request.action === 'readPage') {
    const pageContent = document.body.innerText;
    
    // Initialize matcher for full page
    matcher = new WordMatcher(document.body, 0);

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
      let extraction: ExtractedText = extractTextFromSelection(request.text);
      let textToRead = extraction.text;
      
      if (!textToRead || textToRead.trim().length === 0) {
        extraction = extractTextFromSelectionSimple(request.text);
        textToRead = extraction.text;
      }
      
      if (textToRead && textToRead.trim() !== '') {
        // Initialize WordMatcher with anchor info
        if (extraction.anchorNode && extraction.anchorOffset !== undefined) {
           matcher = new WordMatcher(extraction.anchorNode, extraction.anchorOffset);
        } else {
           matcher = null;
        }

        // Clear the selection if highlighting is enabled
        const selection = window.getSelection();
        if (currentSettings.enableHighlighting && selection) {
          selection.removeAllRanges();
        }
        
        // Reset accumulated words for sentence mode
        accumulatedWords = [];

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
  // Handle word boundary events from offscreen playback for highlighting
  else if (request.action === 'highlightWord') {
    
    if (matcher && currentSettings.enableHighlighting) {
      const mode = currentSettings.highlightGranularity || 'word';
      const text = request.text as string;
      
      let shouldHighlight = true;
      
      if (mode === 'sentence') {
        if (accumulatedWords.length > 0) {
          const prevWord = accumulatedWords[accumulatedWords.length - 1];
          shouldHighlight = /[.!?]["']?$/.test(prevWord.trim());
        }
        accumulatedWords.push(text);
        accumulatedWords.push(text);
      }
      
      if (!shouldHighlight) {
        matcher.advancePosition(text);
        return;
      }
      
      const node = matcher.highlightWord(text, mode);

      if (currentSettings.autoScroll && node) {
        try {
          const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
          if (element) {
            const rect = element.getBoundingClientRect();
            const isInViewport = (
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
              rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );

            if (!isInViewport) {
              element.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'nearest'
              });
            }
          }
        } catch(e) {
          // Ignore scroll errors
        }
      }
    }
  }
  else if (request.action === 'extractTextFromHere' && request.text) {
    try {
      let extraction = extractTextFromSelection(request.text);
      let textToRead = extraction.text;
      if (!textToRead || textToRead.trim().length === 0) {
        extraction = extractTextFromSelectionSimple(request.text);
        textToRead = extraction.text;
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
  
  // Load settings for highlighting support (in case not already loaded)
  const settings = await browser.storage.sync.get({
    enableHighlighting: false,
    highlightColor: "#ffe42e",
    highlightGranularity: 'word',
    autoScroll: false,
  });
  currentSettings = { ...currentSettings, ...settings };
  
  // Apply highlight color
  if (settings.highlightColor) {
    document.documentElement.style.setProperty('--etts-highlight-bg', settings.highlightColor as string);
  }
  
  // Note: Matcher should already be initialized in initTTSViaOffscreen
  // Don't reinitialize here as the selection may already be gone
  
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
  console.debug('[ContentScript] updateUIForState:', state);
  
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
      // Clear matcher and highlight
      if (matcher) {
        matcher.clear();
        matcher = null;
      }
      accumulatedWords = [];
      break;
    case 'error':
      isPlaying = false;
      usingOffscreenAudio = false;
      if (controlPanel) {
        updatePanelContent(controlPanel, false, 'Offscreen playback error');
      } else {
        removeControlPanel();
      }
      // Clear matcher
      if (matcher) {
        matcher.clear();
        matcher = null;
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
