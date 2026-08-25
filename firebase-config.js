// Generated from config/environments.json. Do not edit by hand.
export const ENVIRONMENT = "production";
export const ENVIRONMENT_LABEL = "";
export const firebaseConfig = {
  "apiKey": "AIzaSyDY13rUZCN0q2Izo8i59JHKmWvnu_0Tw7Q",
  "authDomain": "station-102.firebaseapp.com",
  "projectId": "station-102",
  "storageBucket": "station-102.firebasestorage.app",
  "messagingSenderId": "52676411962",
  "appId": "1:52676411962:web:73d3c0b2a51d7524ac2b03"
};
export const STATION_ID = "eilat_102";
export const DEFAULT_VAPID = "BGjGPb4X4kZ--G_fCg5ssV9i3yXuijLtRs_wS8oq85R6jNxn1O62HmCOHi59tLcjn4qu94DRqlF19HE0HbX_htI";
export const RECAPTCHA_SITE_KEY = "";

export function installEnvironmentBanner() {
  if (ENVIRONMENT === 'production' || typeof document === 'undefined') return;
  const show = () => {
    if (document.getElementById('resq-environment-banner')) return;
    const el = document.createElement('div');
    el.id = 'resq-environment-banner';
    el.textContent = ENVIRONMENT_LABEL || 'סביבת בדיקות';
    el.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:50%;' +
      'transform:translateX(-50%);background:#ffd43b;color:#111;padding:5px 14px;' +
      'font:700 13px Arial;border-radius:0 0 8px 8px;box-shadow:0 2px 8px #0006';
    document.body.appendChild(el);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
}

installEnvironmentBanner();
