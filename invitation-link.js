// A personal invitation is a one-use bearer capability. Keep it in the URL
// fragment (not the query sent to Hosting), then remove it from browser history.
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export function personalInvitationLink(base, inviteId, secret) {
  if (!TOKEN.test(inviteId) || !SECRET.test(secret)) throw new TypeError('Invalid invitation');
  const url = new URL('login.html', base);
  url.hash = 'invite=' + inviteId + '.' + secret;
  return url.href;
}

export function consumePersonalInvitation(win) {
  const value = String(win.location.hash || '').replace(/^#invite=/, '');
  if (!String(win.location.hash || '').startsWith('#invite=')) return null;
  const dot = value.indexOf('.');
  const id = value.slice(0, dot), secret = value.slice(dot + 1);
  const result = dot > 0 && TOKEN.test(id) && SECRET.test(secret)
    ? Object.freeze({ invite_id:id, secret }) : null;
  const url = new URL(win.location.href);
  url.hash = '';
  win.history.replaceState(win.history.state, '', url.pathname + url.search);
  return result;
}
