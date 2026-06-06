import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { VideoConfigPage } from './components/VideoConfigPage';
import './styles/global.css';

const Root = window.location.pathname === '/cookbook-video-config' ? VideoConfigPage : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
