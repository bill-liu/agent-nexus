import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app.js';
import type {DesktopBridge} from '../../../packages/contracts/src/events.js';
declare global {interface Window {an:DesktopBridge}}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
