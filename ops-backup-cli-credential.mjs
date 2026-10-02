// In-memory adapter only. Does not log or persist any credential.
export function createBackupRefreshHandler(getToken, now = Date.now) {
  return async () => {
    const token = await getToken();
    const expiry = Number(token?.expires_at);
    if (typeof token?.access_token !== 'string' || !token.access_token ||
        !Number.isFinite(expiry) || expiry <= now()) throw Error('valid CLI token unavailable');
    return {access_token:token.access_token,expiry_date:expiry};
  };
}
