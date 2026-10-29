import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App mini={window.location.hash === '#mini'} />
    </StrictMode>,
  );
}
