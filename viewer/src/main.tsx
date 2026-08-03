import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/inter';
import './theme.css';

// Pre-hydration theme (carried pattern: no flash on load).
document.documentElement.dataset.theme = localStorage.getItem('legion-viewer-theme') ?? 'light';

createRoot(document.getElementById('root')!).render(<App />);
