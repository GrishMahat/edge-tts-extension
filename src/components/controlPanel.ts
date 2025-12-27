import browser from 'webextension-polyfill';
import { circlePause, circleStop } from '../lib/svgs';

export async function createControlPanel(isLoading = true): Promise<HTMLElement> {
	const settings = await browser.storage.sync.get({
		darkMode: false,
	});

	const panel = document.createElement('div');
	panel.className = 'etts-tts-controls';
	panel.id = 'tts-control-panel';

	if (settings.darkMode) {
		panel.dataset.theme = 'dark';
	}

	updatePanelContent(panel, isLoading);
	document.body.appendChild(panel);
	return panel;
}

export function updatePanelContent(panel: HTMLElement, isLoading: boolean, error?: string): void {
	panel.innerHTML = `
		${isLoading ? `
			<div class="etts-flex-center etts-loading-container">
				<span>Generating audio...</span>
				<div class="etts-loading-spinner"></div>
				<button id="tts-cancel" class="etts-tts-button etts-red">
					${circleStop}
					<span>Cancel</span>
				</button>
			</div>
		` : error ? `
			<div class="etts-error-container">
				<div class="etts-error-header">
					<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
					<span>TTS Server Error</span>
				</div>
				<div class="etts-error-message">
					Microsoft's free TTS service is currently experiencing instability. Please try again later.
				</div>
				<div class="etts-error-actions">
					<button id="tts-close-error" class="etts-tts-button etts-red">
						${circleStop}
						<span>Close</span>
					</button>
				</div>
			</div>
		` : `
			<div class="etts-flex-center">
				<button id="tts-pause" class="etts-tts-button">
					${circlePause}
					<span>Pause</span>
				</button>
				<button id="tts-stop" class="etts-tts-button etts-red">
					${circleStop}
					<span>Stop</span>
				</button>
			</div>
		`}
	`;

	if (isLoading) {
		const cancelButton = panel.querySelector('#tts-cancel');
		if (cancelButton) cancelButton.addEventListener('click', () => {
			(window as any).stopPlayback?.();
		});
	} else if (error) {
		const closeButton = panel.querySelector('#tts-close-error');
		if (closeButton) closeButton.addEventListener('click', () => {
			(window as any).stopPlayback?.();
		});
	} else {
		const pauseButton = panel.querySelector('#tts-pause');
		const stopButton = panel.querySelector('#tts-stop');

		if (pauseButton) pauseButton.addEventListener('click', () => {
			(window as any).togglePause?.();
		});

		if (stopButton) stopButton.addEventListener('click', () => {
			(window as any).stopPlayback?.();
		});
	}
}

