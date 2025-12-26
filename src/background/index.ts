// src/background/index.ts
import browser from 'webextension-polyfill';

// Offscreen document management
const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
let creatingOffscreenDocument: Promise<void> | null = null;

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
  if (hasOffscreenAPI()) {
    // Use offscreen document
    await setupOffscreenDocument();
    await browser.runtime.sendMessage({
      action: `offscreen:${action}`,
      ...data,
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
    if (hasOffscreenAPI()) {
      const settings = await getTTSSettings();
      await sendToAudioPlayer('readText', {
        text: info.selectionText,
        settings,
      }, tabId);
      // Also notify content script to show UI
      browser.tabs.sendMessage(tabId, {
        action: 'showPlaybackUI',
      }).catch(() => {});
    } else {
      browser.tabs.sendMessage(tabId, {
        action: 'readText',
        text: info.selectionText,
      });
    }
  } else if (info.menuItemId === 'readPage' && tabId !== undefined) {
    // Get page content first
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText,
      });
      const pageContent = results[0]?.result as string;
      
      if (pageContent && pageContent.trim()) {
        if (hasOffscreenAPI()) {
          const settings = await getTTSSettings();
          await sendToAudioPlayer('readText', {
            text: pageContent,
            settings,
          }, tabId);
          browser.tabs.sendMessage(tabId, {
            action: 'showPlaybackUI',
          }).catch(() => {});
        } else {
          browser.tabs.sendMessage(tabId, {
            action: 'readPage',
          });
        }
      }
    } catch (error) {
      console.error('Error getting page content:', error);
    }
  } else if (info.menuItemId === 'readFromHere' && info.selectionText && tabId !== undefined) {
    // For readFromHere, we need the content script to extract text from selection point
    // Then relay that text to offscreen
    if (hasOffscreenAPI()) {
      // Request text extraction from content script
      try {
        const response = await browser.tabs.sendMessage(tabId, {
          action: 'extractTextFromHere',
          text: info.selectionText,
        }) as { text?: string };
        
        if (response?.text) {
          const settings = await getTTSSettings();
          await sendToAudioPlayer('readText', {
            text: response.text,
            settings,
          }, tabId);
          browser.tabs.sendMessage(tabId, {
            action: 'showPlaybackUI',
          }).catch(() => {});
        }
      } catch (error) {
        console.error('Error extracting text from here:', error);
      }
    } else {
      browser.tabs.sendMessage(tabId, {
        action: 'readFromHere',
        text: info.selectionText,
      });
    }
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
          if (hasOffscreenAPI()) {
            const settings = await getTTSSettings();
            await sendToAudioPlayer('readText', {
              text: selectedText,
              settings,
            }, tabId);
            browser.tabs.sendMessage(tabId, {
              action: 'showPlaybackUI',
            }).catch(() => {});
          } else {
            browser.tabs.sendMessage(tabId, {
              action: 'readText',
              text: selectedText,
            });
          }
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
          if (hasOffscreenAPI()) {
            const settings = await getTTSSettings();
            await sendToAudioPlayer('readText', {
              text: pageContent,
              settings,
            }, tabId);
            browser.tabs.sendMessage(tabId, {
              action: 'showPlaybackUI',
            }).catch(() => {});
          } else {
            browser.tabs.sendMessage(tabId, {
              action: 'readPage',
            });
          }
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
          if (hasOffscreenAPI()) {
            // Request text extraction from content script
            const response = await browser.tabs.sendMessage(tabId, {
              action: 'extractTextFromHere',
              text: selectedText,
            }) as { text?: string };
            
            if (response?.text) {
              const settings = await getTTSSettings();
              await sendToAudioPlayer('readText', {
                text: response.text,
                settings,
              }, tabId);
              browser.tabs.sendMessage(tabId, {
                action: 'showPlaybackUI',
              }).catch(() => {});
            }
          } else {
            browser.tabs.sendMessage(tabId, {
              action: 'readFromHere',
              text: selectedText,
            });
          }
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

// Listen for playback state updates from offscreen document
browser.runtime.onMessage.addListener(function handleMessage(
  message: PlaybackStateMessage,
  sender,
  sendResponse
) {
  if (message.action === 'playbackState') {
    // Forward to active tab's content script for UI updates
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        browser.tabs.sendMessage(tabId, {
          action: 'updatePlaybackState',
          state: message.state,
          error: message.error,
        }).catch(() => {});
      }
    });
  }
} as browser.Runtime.OnMessageListener);