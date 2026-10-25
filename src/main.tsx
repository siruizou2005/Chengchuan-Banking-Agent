import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GradientDefs } from './icons';
import './styles.css';
import './pages/oak.css';
import './pages/oak-system.css';
import './pages/satin.css';
import './chengchuan.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><GradientDefs /><App /></React.StrictMode>);
