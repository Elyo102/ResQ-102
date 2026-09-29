import { test, expect } from './invitation.fixture.mjs';

async function account(page) {
  await page.locator('#invitationEmail').fill('synthetic@example.invalid');
  await page.locator('#invitationPassword').fill('SyntheticPassword123');
  await page.locator('#invitationCreate').click();
  await expect(page.locator('#invitationStatus')).toContainText('החשבון מחובר');
  await page.locator('#invitationId').fill('synthetic_invitation');
  await page.locator('#invitationSecret').fill('synthetic_secret');
}

test('unverified account cannot redeem or claim server approval', async ({ invitation }) => {
  const { page } = await invitation.open('one');
  await account(page);
  await page.locator('#invitationRedeem').click();
  await expect(page.locator('#invitationStatus')).toContainText('עדיין לא אומתה');
  expect(await page.evaluate(() => fixture.calls)).toEqual([]);
});

test('lost response retains exact retry intent and clears secret only on success', async ({ invitation }) => {
  const { page } = await invitation.open('one');
  await account(page);
  await page.evaluate(() => { fixture.verify(); fixture.failure = true; });
  await page.locator('#invitationRedeem').click();
  await expect(page.locator('#invitationStatus')).toContainText('הפעולה לא הושלמה');
  await expect(page.locator('#invitationSecret')).toHaveValue('synthetic_secret');
  await page.locator('#invitationRedeem').click();
  await expect(page.locator('#invitationStatus')).toContainText('ההזמנה מומשה');
  const calls = await page.evaluate(() => fixture.calls);
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
  // CI base 70d770e accepts exactly three fields. The newer product branch
  // retains its separate terms-1.3 assertion; this is not consent acceptance.
  expect(Object.keys(calls[0]).sort()).toEqual(['invite_id', 'request_id', 'secret']);
  expect(calls[0]).toEqual({ invite_id: 'synthetic_invitation',
    request_id: 'synthetic_request_1', secret: 'synthetic_secret' });
  await expect(page.locator('#invitationSecret')).toHaveValue('');
  await expect(page.locator('#invitationStatus')).toContainText('עדיין לא הוענקו הרשאות');
});

test('offline/reconnect preserves entered draft without fabricating success', async ({ invitation }) => {
  const { page, context } = await invitation.open('one');
  await page.locator('#invitationEmail').fill('synthetic@example.invalid');
  await page.locator('#invitationPassword').fill('SyntheticPassword123');
  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(page.locator('#invitationEmail')).toHaveValue('synthetic@example.invalid');
  await expect(page.locator('#invitationPassword')).toHaveValue('SyntheticPassword123');
  expect(await page.evaluate(() => fixture.calls)).toEqual([]);
  await context.setOffline(false);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.locator('#invitationCreate').click();
  await expect(page.locator('#invitationStatus')).toContainText('החשבון מחובר');
  // This tests draft retention, NOT background sync or offline authorization.
});

test('separate contexts isolate identities and late old-user response', async ({ invitation }) => {
  const first = await invitation.open('one'), second = await invitation.open('two');
  expect(first.context).not.toBe(second.context);
  await Promise.all([account(first.page), account(second.page)]);
  await expect(first.page.locator('#invitationWho')).toContainText('one@example.invalid');
  await expect(second.page.locator('#invitationWho')).toContainText('two@example.invalid');
  await first.page.evaluate(() => { fixture.verify(); fixture.hold = true; });
  await first.page.locator('#invitationRedeem').click();
  await expect.poll(() => first.page.evaluate(() => fixture.calls.length)).toBe(1);
  await first.page.evaluate(() => { fixture.switchActor('replacement'); fixture.release(); });
  await expect(first.page.locator('#invitationWho')).toContainText('replacement@example.invalid');
  await expect(first.page.locator('#invitationStatus')).toHaveText('');
  await expect(first.page.locator('#invitationSecret')).toHaveValue('');
  expect(await second.page.evaluate(() => fixture.calls)).toEqual([]);
  await expect(second.page.locator('#invitationSecret')).toHaveValue('synthetic_secret');
});
