import React from 'react';
import { createRoot } from 'react-dom/client'; // Updated import for React 18
import App from './App.js';
import './index.css';

// Create a root element
const container = document.getElementById('root');
const root = createRoot(container);

// Render the app
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);