import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, consumeBootstrap } from './api';
import { TooltipProvider } from './components/ui/tooltip';
import './theme.css';
import './fonts.css';
import './styles.css';
import './stitch.css';

// Consume once, outside React's lifecycle (including StrictMode's effect replay).
const session = api.session(consumeBootstrap(window.location, window.history));
createRoot(document.getElementById('root')!).render(<React.StrictMode><TooltipProvider><App initialSession={session} /></TooltipProvider></React.StrictMode>);
