import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GradientDefs } from './icons';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><GradientDefs /><App /></React.StrictMode>);
