// src/popup/index.tsx
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import './styles.css';
import { ChevronDown, ChevronRight, MoonIcon, SunIcon } from 'lucide-react';
import { isFirefox } from '../utils/browserDetection';

// Top voices to be displayed in the dropdown
const TOP_VOICES = [
  'en-US-AndrewNeural',
  'en-US-AriaNeural',
  'en-US-AvaNeural',
  'en-US-ChristopherNeural',
  'en-US-SteffanNeural',
  'en-IE-ConnorNeural',
  'en-GB-RyanNeural',
  'en-GB-SoniaNeural',
  'en-AU-NatashaNeural',
  'en-AU-WilliamNeural',
];

interface CollapsibleProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

const Collapsible: React.FC<CollapsibleProps> = ({ title, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span className="font-medium text-sm">{title}</span>
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {isOpen && (
        <div className="p-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          {children}
        </div>
      )}
    </div>
  );
};

function Popup() {
  const voices = TOP_VOICES;
  const [selectedVoice, setSelectedVoice] = useState<string>('en-US-ChristopherNeural');
  const [customVoice, setCustomVoice] = useState<string>('');
  const [speed, setSpeed] = useState<number>(1.2);
  const [pitch, setPitch] = useState<number>(0); // Hz
  const [volume, setVolume] = useState<number>(0); // % modification
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [enableHighlighting, setEnableHighlighting] = useState<boolean>(true);
  const [highlightColor, setHighlightColor] = useState<string>('#ffe42e');
  const [highlightGranularity, setHighlightGranularity] = useState<string>('word');
  const [autoScroll, setAutoScroll] = useState<boolean>(false);

  useEffect(() => {
    // Load saved settings
    browser.storage.sync.get(['voiceName', 'speed', 'customVoice', 'darkMode', 'pitch', 'volume', 'enableHighlighting', 'highlightColor', 'highlightGranularity', 'autoScroll']).then((result) => {
      if (result.voiceName) {
        setSelectedVoice(result.voiceName as string);
      }
      if (result.speed) {
        setSpeed(result.speed as number);
      }
      if (result.customVoice) {
        setCustomVoice(result.customVoice as string);
      }
      if (result.pitch) {
         const p = parseInt((result.pitch as string).replace('Hz', ''), 10);
         setPitch(isNaN(p) ? 0 : p);
      }
      if (result.volume) {
         const v = parseInt((result.volume as string).replace('%', ''), 10);
         setVolume(isNaN(v) ? 0 : v);
      }
      if (result.darkMode !== undefined) {
        setDarkMode(result.darkMode as boolean);
        document.documentElement.classList.toggle('dark', result.darkMode as boolean);
      }
      if (result.enableHighlighting !== undefined) {
          setEnableHighlighting(result.enableHighlighting as boolean);
      }
      if (result.highlightColor) {
          setHighlightColor(result.highlightColor as string);
      }
      if (result.highlightGranularity) {
          setHighlightGranularity(result.highlightGranularity as string);
      }
      if (result.autoScroll !== undefined) {
          setAutoScroll(result.autoScroll as boolean);
      }
    });
  }, []);

  const handleVoiceChange = (voice: string) => {
    setSelectedVoice(voice);
    browser.storage.sync.set({ voiceName: voice });
  };

  const handleCustomVoiceChange = (customVoice: string) => {
    setCustomVoice(customVoice);
    browser.storage.sync.set({ customVoice: customVoice });
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    browser.storage.sync.set({ speed: newSpeed });
  };

  const handlePitchChange = (newPitch: number) => {
      setPitch(newPitch);
      const pitchStr = newPitch >= 0 ? `+${newPitch}Hz` : `${newPitch}Hz`;
      browser.storage.sync.set({ pitch: pitchStr });
  };

  const handleVolumeChange = (newVolume: number) => {
      setVolume(newVolume);
      const volumeStr = newVolume >= 0 ? `+${newVolume}%` : `${newVolume}%`;
      browser.storage.sync.set({ volume: volumeStr });
  };

  const handleEnableHighlightingChange = (enabled: boolean) => {
      setEnableHighlighting(enabled);
      browser.storage.sync.set({ enableHighlighting: enabled });
  };

  const handleHighlightColorChange = (color: string) => {
      setHighlightColor(color);
      browser.storage.sync.set({ highlightColor: color });
  };

  const handleHighlightGranularityChange = (granularity: string) => {
    setHighlightGranularity(granularity);
    browser.storage.sync.set({ highlightGranularity: granularity });
  };
  
  const handleAutoScrollChange = (enabled: boolean) => {
      setAutoScroll(enabled);
      browser.storage.sync.set({ autoScroll: enabled });
  };

  const handleDarkModeToggle = () => {
    const newDarkMode = !darkMode;
    setDarkMode(newDarkMode);
    document.documentElement.classList.toggle('dark', newDarkMode);
    browser.storage.sync.set({ darkMode: newDarkMode });
  };

  const handlePlayClick = async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id) {
        console.error('No active tab found');
        return;
      }

      const injectionResults = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText,
      });

      for (const frameResult of injectionResults) {
        const pageContent = frameResult.result as string;
        if (!pageContent || !pageContent.trim()) {
          console.warn('The page content is empty.');
          continue;
        }

        if (isFirefox()) {
          // 🔁 Firefox workaround: inject postMessage in page context
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: (text) => {
              window.postMessage({ action: 'triggerTTS', text }, '*');
            },
            args: [pageContent],
          });
        } else {
          await browser.tabs.sendMessage(tab.id, {
            action: 'readText',
            text: pageContent,
          });
        }
      }
    } catch (error) {
      console.error('Error sending TTS message:', error);
    }
  };

  return (
    <div className="p-4 w-80 min-h-[400px] bg-white dark:bg-gray-800 dark:text-white transition-colors" style={{ maxHeight: '600px', overflowY: 'auto' }}>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold select-none">Edge TTS</h1>
        <div
          className="cursor-pointer p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          onClick={() => handleDarkModeToggle()}
        >
          {darkMode ? <MoonIcon size={20} /> : <SunIcon size={20} />}
        </div>
      </div>

      <Collapsible title="Voice Settings" defaultOpen={true}>
        <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Select Voice</label>
        <select
          className="w-full p-2 text-sm border rounded dark:bg-slate-700 dark:border-slate-600 outline-none"
          value={selectedVoice}
          onChange={(e) => handleVoiceChange(e.target.value)}
        >
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
        
        <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mt-3 mb-1">Or Custom Voice</label>
        <input
          type="text"
          className="w-full p-2 text-sm border rounded dark:bg-slate-700 dark:border-slate-600 outline-none"
          placeholder="e.g. en-US-EmmaMultilingualNeural"
          value={customVoice}
          onChange={(e) => handleCustomVoiceChange(e.target.value)}
        />
        
        <div className='text-center mt-2 text-xs text-blue-500'>
          <a href='https://tts.travisvn.com' target='_blank' className='hover:underline'>
            Preview voices
          </a>
        </div>
      </Collapsible>

      <Collapsible title="Audio Settings">
        <div className="mb-4">
          <div className="flex justify-between mb-1">
            <label className="text-sm font-medium">Speed</label>
            <span className="text-xs text-gray-500">{speed}x</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={speed}
            onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-blue-600"
          />
        </div>

        <div className="mb-4">
          <div className="flex justify-between mb-1">
            <label className="text-sm font-medium">Pitch</label>
            <span className="text-xs text-gray-500">{pitch}Hz</span>
          </div>
          <input
            type="range"
            min="-50"
            max="50"
            step="5"
            value={pitch}
            onChange={(e) => handlePitchChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-blue-600"
          />
        </div>

        <div>
          <div className="flex justify-between mb-1">
            <label className="text-sm font-medium">Volume</label>
            <span className="text-xs text-gray-500">{volume > 0 ? '+' : ''}{volume}%</span>
          </div>
          <input
            type="range"
            min="-50"
            max="50"
            step="10"
            value={volume}
            onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-blue-600"
          />
        </div>
      </Collapsible>

      <Collapsible title="Appearance">
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm">Enable Highlighting</label>
          <input 
            type="checkbox" 
            checked={enableHighlighting}
            onChange={(e) => handleEnableHighlightingChange(e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700"
          />
        </div>

        {enableHighlighting && (
          <div className="pl-2 border-l-2 border-gray-100 dark:border-gray-700 space-y-3">
             <div className="flex items-center justify-between">
                 <label className="text-sm">Highlight Color</label>
                 <div className="relative w-8 h-8 rounded-full overflow-hidden border border-gray-200 dark:border-gray-600 shadow-sm">
                   <input 
                      type="color" 
                      value={highlightColor}
                      onChange={(e) => handleHighlightColorChange(e.target.value)}
                      className="absolute inset-0 w-[150%] h-[150%] -top-1/4 -left-1/4 p-0 cursor-pointer border-none" 
                   />
                 </div>
             </div>
             
             <div>
                <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Granularity</label>
                <select
                  className="w-full p-2 text-sm border rounded dark:bg-slate-700 dark:border-slate-600 outline-none"
                  value={highlightGranularity}
                  onChange={(e) => handleHighlightGranularityChange(e.target.value)}
                >
                  <option value="word">Word by Word</option>
                  <option value="sentence">Sentence by Sentence</option>
                </select>
             </div>

             <div className="flex items-center justify-between pt-1">
                <label className="text-sm">Auto-scroll</label>
                <input 
                    type="checkbox" 
                    checked={autoScroll}
                    onChange={(e) => handleAutoScrollChange(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700"
                />
            </div>
          </div>
        )}
      </Collapsible>

      <div className="mt-4">
        <button
          onClick={() => handlePlayClick()}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow transition-colors flex items-center justify-center gap-2"
        >
          <span>Read Current Page</span>
        </button>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
const root = createRoot(container!); // createRoot(container!) if you use TypeScript
root.render(<Popup />);