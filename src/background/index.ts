// src/background/index.ts
import browser from 'webextension-polyfill';

// Offscreen document management
const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
let creatingOffscreenDocument: Promise<void> | null = null;

// Track the originating tab for playback state updates
let originatingTabId: number | null = null;

/**
 * Check if offscreen document exists (Chrome MV3 only)
 */
async function hasOffscreenDocument(): Promise<boolean> {
  // Check if we're in Chrome with offscreen API
  if (typeof chrome !== 'undefined' && chrome.offscreen) {
    try {
      const contexts = await (chrome as any).runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
      });
      return contexts.length > 0;
    } catch (e) {
      // Fallback for older Chrome versions
      return false;
    }
  }
  return false;
}

/**
 * Create offscreen document for audio playback (Chrome MV3 only)
 */
async function setupOffscreenDocument(): Promise<void> {
  // Only works in Chrome with offscreen API
  if (typeof chrome === 'undefined' || !chrome.offscreen) {
    console.log('Offscreen API not available, using content script audio');
    return;
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = (chrome as any).offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play text-to-speech audio without CSP restrictions',
  });

  try {
    await creatingOffscreenDocument;
    console.log('Offscreen document created');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
  } finally {
    creatingOffscreenDocument = null;
  }
}

/**
 * Check if offscreen API is available
 */
function hasOffscreenAPI(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.offscreen;
}

/**
 * Send message to offscreen document or content script
 */
async function sendToAudioPlayer(action: string, data?: any, tabId?: number): Promise<void> {
  // Store the originating tab when starting playback
  if (action === 'readText' && tabId !== undefined) {
    originatingTabId = tabId;
  }

  if (hasOffscreenAPI()) {
    // Use offscreen document
    await setupOffscreenDocument();
    await browser.runtime.sendMessage({
      action: `offscreen:${action}`,
      ...data,
      originatingTabId: tabId,
    });
  } else if (tabId !== undefined) {
    // Fallback to content script
    await browser.tabs.sendMessage(tabId, {
      action,
      ...data,
    });
  }
}

/**
 * Get TTS settings from storage
 */
async function getTTSSettings() {
  return browser.storage.sync.get({
    voiceName: 'en-US-ChristopherNeural',
    customVoice: '',
    speed: 1.2,
  });
}

browser.runtime.onInstalled.addListener(() => {
  // Add context menu for reading selected text
  browser.contextMenus.create({
    id: 'readAloud',
    title: 'Read Aloud with Edge TTS',
    contexts: ['selection'],
  });

  // Add context menu for reading the entire page
  browser.contextMenus.create({
    id: 'readPage',
    title: 'Read Page Aloud with Edge TTS',
    contexts: ['page'],
  });

  // Add context menu for reading from here (when text is selected)
  browser.contextMenus.create({
    id: 'readFromHere',
    title: 'Start reading aloud from here',
    contexts: ['selection'],
  });

  // Pre-create offscreen document
  if (hasOffscreenAPI()) {
    setupOffscreenDocument().catch(console.error);
  }
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;

  if (info.menuItemId === 'readAloud' && info.selectionText && tabId !== undefined) {
    // Send directly to content script like the popup does - this is more reliable
    browser.tabs.sendMessage(tabId, {
      action: 'readText',
      text: info.selectionText,
    }).catch((error) => {
      console.error('Error sending TTS message:', error);
    });
  } else if (info.menuItemId === 'readPage' && tabId !== undefined) {
    // Get page content first
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText,
      });
      const pageContent = results[0]?.result as string;
      
      if (pageContent && pageContent.trim()) {
        // Send directly to content script like the popup does
        browser.tabs.sendMessage(tabId, {
          action: 'readText',
          text: pageContent,
        }).catch((error) => {
          console.error('Error sending TTS message:', error);
        });
      }
    } catch (error) {
      console.error('Error getting page content:', error);
    }
  } else if (info.menuItemId === 'readFromHere' && info.selectionText && tabId !== undefined) {
    // Send directly to content script which will extract text from selection point
    browser.tabs.sendMessage(tabId, {
      action: 'readFromHere',
      text: info.selectionText,
    }).catch((error) => {
      console.error('Error sending TTS message:', error);
    });
  }
});

// Handle keyboard commands
browser.commands.onCommand.addListener(async (command) => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const tabId = tab?.id;

  if (!tabId) {
    console.error('No active tab found for command:', command);
    return;
  }

  switch (command) {
    case 'read-selection':
      // Get selected text and read it
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() || '',
        });

        const selectedText = results[0]?.result as string;
        if (selectedText && selectedText.trim()) {
          // Send directly to content script like the popup does
          browser.tabs.sendMessage(tabId, {
            action: 'readText',
            text: selectedText,
          }).catch((error) => {
            console.error('Error sending TTS message:', error);
          });
        } else {
          console.warn('No text selected for read-selection command');
        }
      } catch (error) {
        console.error('Error getting selected text:', error);
      }
      break;

    case 'read-page':
      // Read entire page
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId },
          func: () => document.body.innerText,
        });
        const pageContent = results[0]?.result as string;
        
        if (pageContent && pageContent.trim()) {
          // Send directly to content script like the popup does
          browser.tabs.sendMessage(tabId, {
            action: 'readText',
            text: pageContent,
          }).catch((error) => {
            console.error('Error sending TTS message:', error);
          });
        }
      } catch (error) {
        console.error('Error reading page:', error);
      }
      break;

    case 'read-from-here':
      // Get selected text and read from that position
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() || '',
        });

        const selectedText = results[0]?.result as string;
        if (selectedText && selectedText.trim()) {
          // Send directly to content script which will extract text from selection point
          browser.tabs.sendMessage(tabId, {
            action: 'readFromHere',
            text: selectedText,
          }).catch((error) => {
            console.error('Error sending TTS message:', error);
          });
        } else {
          console.warn('No text selected for read-from-here command');
        }
      } catch (error) {
        console.error('Error getting selected text for read-from-here:', error);
      }
      break;

    case 'toggle-playback':
      // Toggle play/pause
      if (hasOffscreenAPI()) {
        await sendToAudioPlayer('togglePlayback', {}, tabId);
      } else {
        browser.tabs.sendMessage(tabId, {
          action: 'togglePlayback',
        });
      }
      break;

    default:
      console.warn('Unknown command:', command);
  }
});

interface PlaybackStateMessage {
  action: string;
  state?: string;
  error?: string;
}

// Listen for messages from content script and offscreen document
browser.runtime.onMessage.addListener(function handleMessage(
  message: PlaybackStateMessage,
  sender,
  sendResponse
) {
  // Handle playback state updates from offscreen document
  if (message.action === 'playbackState') {
    // Use originating tab from message or stored value
    const targetTabId = (message as any).originatingTabId || originatingTabId;
    
    if (targetTabId) {
      browser.tabs.sendMessage(targetTabId, {
        action: 'updatePlaybackState',
        state: message.state,
        error: message.error,
      }).catch(() => {});
      
      // Clear originating tab on stopped/error
      if (message.state === 'stopped' || message.state === 'error') {
        originatingTabId = null;
      }
    }
  }
  // Handle offscreen control messages from content script
  else if (message.action === 'offscreen:togglePlayback' || message.action === 'offscreen:stopPlayback') {
    if (hasOffscreenAPI()) {
      // Forward to offscreen document
      setupOffscreenDocument().then(() => {
        // The message is also received by the offscreen document since it's a runtime.sendMessage
        // We just need to make sure offscreen document is created
      }).catch(console.error);
    }
  }
} as browser.Runtime.OnMessageListener);