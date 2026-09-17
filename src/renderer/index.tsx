import { createRoot } from 'react-dom/client';
import App from './App';

/**
 * Chromium rejects a pending video.play() with an AbortError when pause()
 * or a new load interrupts it before playback starts. react-player issues
 * the play() and doesn't catch the promise, so switching or pausing a video
 * that is still starting surfaces as an uncaught rejection in the console.
 * It's harmless, the element ends up in whatever state was requested last,
 * so drop just that error and let anything else through.
 */
window.addEventListener('unhandledrejection', (event) => {
  const { reason } = event;

  if (
    reason?.name === 'AbortError' &&
    typeof reason?.message === 'string' &&
    reason.message.includes('play() request was interrupted')
  ) {
    event.preventDefault();
  }
});

const container = document.getElementById('root')!;
const root = createRoot(container);

root.render(<App />);
