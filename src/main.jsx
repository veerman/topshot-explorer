import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// The apex domain previously hosted a CRA build that shipped a Workbox
// service worker; make sure no historic registration can ever serve stale
// files under this app. Harmless everywhere else.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations?.()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {})
}

// Wait for the app fonts before the first render, so nothing on screen ever
// re-measures when a font swaps in (text renders once, with final metrics).
// Capped: a slow or failed font fetch must never hold the app hostage.
const fontsReady = Promise.race([
  Promise.all([
    document.fonts.load('400 1em Outfit'),
    document.fonts.load('600 1em Outfit'),
    document.fonts.load('700 1em Outfit'),
    document.fonts.load('1em "TopShot Emoji"', '\u{1F3C0}'),
  ]).catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 1500)),
])

fontsReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
