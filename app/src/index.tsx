import React from 'react';
import { createRoot } from 'react-dom/client';
import ServiceWorkerService from './services/ServiceWorkerService';
import App from './components/App/App';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

ServiceWorkerService.registerWorker();
