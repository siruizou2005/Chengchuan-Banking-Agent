import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './chat/ChatApp';
import './chat/chat.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
